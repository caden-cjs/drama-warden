function safeErrorCode(error) {
  const code = String(error?.code || 'AUTOMATION_ERROR');
  return /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'AUTOMATION_ERROR';
}

export function createFollowupAutomationService({
  shows,
  episodes,
  events,
  resourceDiscovery,
  followup,
  now = () => new Date(),
  maxStoragesPerScan = 200,
  candidatesPerStorage = 5,
  maxResponseCandidates = 100,
} = {}) {
  if (!shows || typeof shows.list !== 'function') throw new TypeError('shows repository is required');
  if (!episodes || typeof episodes.listShowStorages !== 'function') {
    throw new TypeError('episode repository is required');
  }
  if (!events || typeof events.list !== 'function') throw new TypeError('event repository is required');
  if (!resourceDiscovery || typeof resourceDiscovery.searchForShow !== 'function') {
    throw new TypeError('resource discovery service is required');
  }
  if (!followup || typeof followup.queueShare !== 'function'
      || typeof followup.processEvent !== 'function') {
    throw new TypeError('follow-up service is required');
  }
  for (const [value, name] of [
    [maxStoragesPerScan, 'maxStoragesPerScan'],
    [candidatesPerStorage, 'candidatesPerStorage'],
    [maxResponseCandidates, 'maxResponseCandidates'],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(name + ' must be a positive integer');
    }
  }

  let activeRun = null;
  let lastRun = null;

  async function processPendingAutomationEvents(stats) {
    const pending = await events.list({ status: 'pending', limit: 1000 });
    for (const event of pending) {
      if (event.kind !== 'new_ep' || event.source !== 'automation') continue;
      try {
        const result = await followup.processEvent(event.id);
        if (result.ok) stats.eventsProcessed += 1;
        else stats.eventsFailed += 1;
      } catch (error) {
        stats.eventsFailed += 1;
        if (stats.errors.length < 100) {
          stats.errors.push({
            eventId: event.id,
            errorCode: safeErrorCode(error),
          });
        }
      }
    }
  }

  async function performScan({ queueCandidates, processQueued } = {}) {
    const startedAt = now().toISOString();
    const stats = {
      startedAt,
      completedAt: null,
      showsChecked: 0,
      storagesChecked: 0,
      candidatesFound: 0,
      eligibleCandidates: 0,
      eventsQueued: 0,
      eventsProcessed: 0,
      eventsFailed: 0,
      storageLimitReached: false,
      errors: [],
      candidates: [],
    };

    if (processQueued) await processPendingAutomationEvents(stats);

    const trackedShows = (await shows.list()).filter((show) =>
      show.mediaType === 'tv' && !show.finished);
    for (const show of trackedShows) {
      stats.showsChecked += 1;
      const storages = await episodes.listShowStorages(show.id, { enabledOnly: true });
      for (const storage of storages) {
        if (stats.storagesChecked >= maxStoragesPerScan) {
          stats.storageLimitReached = true;
          break;
        }
        stats.storagesChecked += 1;
        try {
          const discovery = await resourceDiscovery.searchForShow({
            showId: show.id,
            storageId: storage.id,
            limit: candidatesPerStorage,
          });
          stats.candidatesFound += discovery.results.length;
          const eligible = discovery.results.filter((candidate) =>
            candidate.preview?.eligible === true && candidate.searchComplete !== false);
          stats.eligibleCandidates += eligible.length;
          for (const candidate of discovery.results) {
            if (stats.candidates.length >= maxResponseCandidates) break;
            stats.candidates.push({
              showId: show.id,
              showName: show.name,
              storageId: storage.id,
              providerId: candidate.providerId,
              searchComplete: candidate.searchComplete !== false,
              shareUrl: candidate.shareUrl,
              title: candidate.title,
              sourceId: candidate.sourceId,
              preview: candidate.preview,
            });
          }

          if (queueCandidates && eligible.length > 0) {
            const candidate = eligible[0];
            const queued = await followup.queueShare({
              showId: show.id,
              storageId: storage.id,
              shareUrl: candidate.shareUrl,
              shareTitle: candidate.title,
              source: 'automation',
            });
            if (queued.queued) stats.eventsQueued += 1;
          }
        } catch (error) {
          if (stats.errors.length < 100) {
            stats.errors.push({
              showId: show.id,
              storageId: storage.id,
              errorCode: safeErrorCode(error),
            });
          }
        }
      }
      if (stats.storageLimitReached) break;
    }

    if (processQueued) await processPendingAutomationEvents(stats);
    stats.completedAt = now().toISOString();
    return stats;
  }

  async function runScan({ queueCandidates = false, processQueued = false } = {}) {
    if (typeof queueCandidates !== 'boolean' || typeof processQueued !== 'boolean') {
      throw new TypeError('automation scan options must be booleans');
    }
    if (activeRun) return { skipped: true, reason: 'scan_in_progress' };
    const currentRun = performScan({ queueCandidates, processQueued });
    activeRun = currentRun;
    try {
      const result = await currentRun;
      lastRun = {
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        showsChecked: result.showsChecked,
        storagesChecked: result.storagesChecked,
        candidatesFound: result.candidatesFound,
        eligibleCandidates: result.eligibleCandidates,
        eventsQueued: result.eventsQueued,
        eventsProcessed: result.eventsProcessed,
        eventsFailed: result.eventsFailed,
        errorCount: result.errors.length,
        storageLimitReached: result.storageLimitReached,
      };
      return result;
    } finally {
      if (activeRun === currentRun) activeRun = null;
    }
  }

  return Object.freeze({
    runScan,
    status() {
      return { running: activeRun !== null, lastRun };
    },
  });
}

export function createFollowupScheduler({
  enabled = false,
  intervalMinutes = 30,
  autoProcess = false,
  automation,
  logger = console,
  now = () => new Date(),
} = {}) {
  if (typeof enabled !== 'boolean' || typeof autoProcess !== 'boolean') {
    throw new TypeError('scheduler enabled and autoProcess settings must be booleans');
  }
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new TypeError('intervalMinutes must be between 5 and 1440');
  }
  if (!automation || typeof automation.runScan !== 'function'
      || typeof automation.status !== 'function') {
    throw new TypeError('automation service is required');
  }

  let intervalMs = intervalMinutes * 60 * 1000;
  let timer = null;
  let activeRun = null;
  let lastStartedAt = null;
  let lastErrorCode = null;

  function run(source) {
    if (activeRun) return activeRun;
    lastStartedAt = now().toISOString();
    activeRun = automation.runScan({ queueCandidates: true, processQueued: autoProcess })
      .then((result) => {
        lastErrorCode = null;
        logger.info?.('[followup-scheduler] scan completed', {
          source,
          skipped: result.skipped === true,
          showsChecked: result.showsChecked || 0,
          storagesChecked: result.storagesChecked || 0,
          candidatesFound: result.candidatesFound || 0,
          eventsQueued: result.eventsQueued || 0,
          eventsProcessed: result.eventsProcessed || 0,
          eventsFailed: result.eventsFailed || 0,
          errorCount: result.errors?.length || 0,
        });
        return result;
      })
      .catch((error) => {
        lastErrorCode = safeErrorCode(error);
        logger.error?.('[followup-scheduler] scan failed', { errorCode: lastErrorCode });
        return { skipped: false, errorCode: lastErrorCode };
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  }

  function start() {
    if (!enabled || timer) return false;
    void run('startup');
    timer = setInterval(() => void run('interval'), intervalMs);
    timer.unref?.();
    return true;
  }

  function updateSettings(next = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new TypeError('scheduler settings must be an object');
    }
    const nextEnabled = next.enabled;
    const nextIntervalMinutes = next.intervalMinutes;
    const nextAutoProcess = next.autoProcess;
    if (typeof nextEnabled !== 'boolean' || typeof nextAutoProcess !== 'boolean') {
      throw new TypeError('scheduler enabled and autoProcess settings must be booleans');
    }
    if (!Number.isSafeInteger(nextIntervalMinutes)
        || nextIntervalMinutes < 5 || nextIntervalMinutes > 1440) {
      throw new TypeError('intervalMinutes must be between 5 and 1440');
    }

    const wasEnabled = enabled;
    const intervalChanged = intervalMinutes !== nextIntervalMinutes;
    enabled = nextEnabled;
    intervalMinutes = nextIntervalMinutes;
    intervalMs = intervalMinutes * 60 * 1000;
    autoProcess = nextAutoProcess;

    if (!enabled) {
      stop();
    } else if (!wasEnabled || !timer) {
      start();
    } else if (intervalChanged) {
      clearInterval(timer);
      timer = setInterval(() => void run('interval'), intervalMs);
      timer.unref?.();
    }
    return { enabled, intervalMinutes, autoProcess };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function waitForIdle() {
    if (activeRun) await activeRun;
  }

  function status() {
    return {
      enabled,
      running: activeRun !== null || automation.status().running,
      intervalMinutes,
      autoProcess,
      lastStartedAt,
      lastErrorCode,
      lastRun: automation.status().lastRun,
    };
  }

  return Object.freeze({ start, stop, updateSettings, waitForIdle, status });
}

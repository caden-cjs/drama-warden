import { randomUUID } from 'node:crypto';
import { createFollowupPlan } from './followup-plan.mjs';
import {
  detectQuality,
  episodeFromVideoFile,
  formatCanonicalEpisodeName,
} from './media-naming.mjs';

const REVIEWED_NO_OUTPUT_ERROR = 'INTERRUPTED_REVIEW_CONFIRMED_NO_OUTPUT';

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(field + ' must be a positive integer');
  }
  return id;
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(field + ' is required');
  return text;
}

function cstToday(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return fields.year + '-' + fields.month + '-' + fields.day;
}

function latestStoredProgress(episodes) {
  const present = (episodes || []).filter((item) =>
    item.status === 'present' || item.status === 'conflict' || Number(item.assetCount) > 0);
  present.sort((left, right) => Number(left.seasonNumber) - Number(right.seasonNumber)
    || Number(left.episodeNumber) - Number(right.episodeNumber));
  return present.at(-1) || { seasonNumber: 0, episodeNumber: 0 };
}

function publicManifest(manifest) {
  return {
    providerId: manifest?.providerId || null,
    seasonNumber: manifest?.seasonNumber || null,
    maxEpisode: Number(manifest?.maxEpisode) || 0,
    sufficient: manifest?.sufficient === true,
    failures: Array.isArray(manifest?.failures) ? manifest.failures : [],
  };
}

function safeErrorCode(error) {
  const code = String(error?.code || 'FOLLOWUP_ERROR');
  return /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'FOLLOWUP_ERROR';
}

function joinCloudPath(basePath, name) {
  const base = normalizeCloudPath(basePath, 'storage root');
  const segment = normalizeCloudPath(name, 'path segment');
  if (!segment || segment.startsWith('/') || segment.includes('/')) {
    const error = new Error('storage path segment must be a single name');
    error.code = 'INVALID_STORAGE_PATH';
    throw error;
  }
  if (!base) return segment;
  if (base === '/') return '/' + segment;
  return base + '/' + segment;
}

function normalizeCloudPath(value, label) {
  const rawPath = String(value || '').replace(/\/{2,}/g, '/');
  const absolute = rawPath.startsWith('/');
  const segments = rawPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    const error = new Error(label + ' contains a traversal segment');
    error.code = 'INVALID_STORAGE_PATH';
    throw error;
  }
  return (absolute ? '/' : '') + segments.join('/');
}

function cloudBasename(file) {
  const name = String(file?.name || '');
  if (name) return name;
  const path = String(file?.path || '');
  return path.slice(path.lastIndexOf('/') + 1);
}

function numericSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function mtimeValue(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function requireCompleteListing(result, label) {
  if (!result || !Array.isArray(result.files) || result.truncated !== false) {
    const error = new Error(label + ' listing is incomplete');
    error.status = 409;
    error.code = 'INCOMPLETE_LISTING';
    throw error;
  }
  return result.files;
}

function relativeStoragePath(rootPath, filePath) {
  const root = normalizeCloudPath(rootPath, 'storage root');
  const path = normalizeCloudPath(filePath, 'storage file path');
  if (!path) throw new Error('storage provider returned a file without a path');
  if (!root) return path.replace(/^\//, '');
  if (path === root) throw new Error('storage provider returned a file path equal to its root');
  const prefix = root === '/' ? '/' : root + '/';
  if (!path.startsWith(prefix)) {
    throw new Error('storage provider returned a file outside the configured storage root');
  }
  return path.slice(prefix.length);
}

function storageFileKey(file, rootPath) {
  if (!file || file.isDir) return null;
  const relativePath = relativeStoragePath(rootPath, file.path);
  return relativePath + '\u0000' + (numericSize(file.size) ?? 'unknown');
}

export function createFollowupService({
  shows,
  episodes,
  events,
  metadata,
  listPlugins,
  invoke,
  maxEpisodes = 3,
  maxBytes = 8 * 1024 ** 3,
  now = () => new Date(),
  publishEvent = async () => [],
} = {}) {
  if (!shows || typeof shows.getById !== 'function') {
    throw new TypeError('shows repository is required');
  }
  if (!episodes || typeof episodes.getStorageById !== 'function'
      || typeof episodes.listStorageEpisodes !== 'function'
      || typeof episodes.reserveWrites !== 'function'
      || typeof episodes.releaseUnwrittenClaims !== 'function') {
    throw new TypeError('episode repository is required');
  }
  if (!events || typeof events.create !== 'function' || typeof events.transition !== 'function'
      || typeof events.getById !== 'function'
      || typeof events.finalizeProcessed !== 'function') {
    throw new TypeError('event repository is required');
  }
  if (!metadata || typeof metadata.resolveEpisodeManifest !== 'function') {
    throw new TypeError('metadata service is required');
  }
  if (typeof listPlugins !== 'function' || typeof invoke !== 'function') {
    throw new TypeError('plugin listing and invocation functions are required');
  }
  for (const [repository, method] of [
    [episodes, 'findExistingWriteClaims'],
    [episodes, 'listWriteClaims'],
    [episodes, 'markWritesUncertain'],
    [episodes, 'upsertEpisode'],
    [episodes, 'syncAssets'],
  ]) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError('episode repository is missing ' + method + '()');
    }
  }
  if (typeof publishEvent !== 'function') throw new TypeError('publishEvent must be a function');

  const activeEventIds = new Set();

  async function withEventLock(eventId, operation) {
    if (activeEventIds.has(eventId)) {
      const error = new Error('event processing is still active in this service process');
      error.status = 409;
      error.code = 'EVENT_STILL_ACTIVE';
      throw error;
    }
    activeEventIds.add(eventId);
    try {
      return await operation();
    } finally {
      activeEventIds.delete(eventId);
    }
  }

  async function publishStatus(event, status, payload) {
    try {
      return {
        notifications: await publishEvent({
          id: 'followup-' + event.id + '-' + status,
          type: 'workflow.event.status_changed',
          source: 'followup-service',
          occurredAt: now().toISOString(),
          correlationId: event.correlationId,
          payload,
        }),
      };
    } catch (error) {
      return { notifications: [], notificationErrorCode: safeErrorCode(error) };
    }
  }

  async function previewShare({ showId: showIdValue, storageId: storageIdValue, shareUrl, today } = {}) {
    const showId = positiveId(showIdValue, 'showId');
    const storageId = positiveId(storageIdValue, 'storageId');
    const normalizedShareUrl = requiredText(shareUrl, 'shareUrl');
    const show = await shows.getById(showId);
    if (!show) throw new Error('show ' + showId + ' not found');

    const storage = await episodes.getStorageById(storageId);
    if (!storage || storage.showId !== showId) {
      throw new Error('storage ' + storageId + ' does not belong to show ' + showId);
    }
    if (!storage.enabled) throw new Error('storage ' + storageId + ' is disabled');

    const storagePlugins = listPlugins({
      domain: 'storage',
      capability: 'listSharedFiles',
      enabledOnly: true,
    });
    if (!storagePlugins.some((plugin) => plugin.id === storage.providerId)) {
      throw new Error('storage plugin is not enabled: ' + storage.providerId);
    }

    const storedEpisodes = await episodes.listStorageEpisodes(storageId);
    const progress = latestStoredProgress(storedEpisodes);
    const metadataOptions = {
      currentSeason: Number(progress.seasonNumber) || 0,
      currentEpisode: Number(progress.episodeNumber) || 0,
      requireNextEpisode: true,
      autoLink: true,
    };
    let manifest = await metadata.resolveEpisodeManifest(showId, metadataOptions);
    if (!manifest?.providerId || !Array.isArray(manifest.episodes) || manifest.episodes.length === 0) {
      return {
        eligible: false,
        reason: 'metadata_unavailable',
        show: { id: show.id, name: show.name },
        storage: { id: storage.id, providerId: storage.providerId },
        metadata: publicManifest(manifest),
        plan: null,
      };
    }

    const listing = await invoke(storage.providerId, {
      capability: 'listSharedFiles',
      input: { shareUrl: normalizedShareUrl },
      context: { source: 'followup-preview', showId, storageId },
    });
    if (!listing || !Array.isArray(listing.files) || listing.truncated !== false) {
      return {
        eligible: false,
        reason: 'share_listing_incomplete',
        show: { id: show.id, name: show.name },
        storage: { id: storage.id, providerId: storage.providerId },
        metadata: publicManifest(manifest),
        plan: null,
      };
    }

    manifest = await metadata.resolveEpisodeManifest(showId, {
      ...metadataOptions,
      observedEpisodes: listing.files,
    });
    if (!manifest?.sufficient) {
      return {
        eligible: false,
        reason: 'metadata_coverage_insufficient',
        show: { id: show.id, name: show.name },
        storage: { id: storage.id, providerId: storage.providerId },
        metadata: publicManifest(manifest),
        shareFileCount: listing.files.length,
        plan: null,
      };
    }

    const plan = createFollowupPlan({
      seasonNumber: manifest.seasonNumber,
      metadataEpisodes: manifest.episodes,
      storedEpisodes,
      sharedFiles: listing.files,
      today: today || cstToday(now()),
      maxEpisodes,
      maxBytes,
    });
    return {
      eligible: plan.saveBatch.length > 0,
      reason: plan.saveBatch.length > 0 ? null : 'no_confirmed_missing_episodes',
      show: { id: show.id, name: show.name },
      storage: { id: storage.id, providerId: storage.providerId, rootPath: storage.rootPath },
      metadata: publicManifest(manifest),
      shareFileCount: listing.files.length,
      plan,
    };
  }

  async function queueShare(input = {}) {
    const preview = await previewShare(input);
    if (!preview.eligible || !preview.plan) return { queued: false, preview };

    const showId = positiveId(input.showId, 'showId');
    const storageId = positiveId(input.storageId, 'storageId');
    const correlationId = input.correlationId == null
      ? randomUUID()
      : requiredText(input.correlationId, 'correlationId');
    const selectedFiles = preview.plan.saveBatch.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size,
      path: file.path,
      seasonNumber: file.seasonNumber,
      episodeNumber: file.episodeNumber,
      quality: file.quality,
    }));
    const existingClaims = await episodes.findExistingWriteClaims({
      storageId,
      seasonNumber: preview.plan.seasonNumber,
      episodeNumbers: selectedFiles.map((file) => file.episodeNumber),
    });
    if (existingClaims.length > 0) {
      return {
        queued: false,
        reason: 'episode_write_claimed',
        blocked: existingClaims,
        preview,
      };
    }
    const source = input.source === 'automation' ? 'automation' : 'manual';
    const event = await events.create({
      showId,
      kind: 'new_ep',
      source,
      correlationId,
      payload: {
        storageId,
        providerId: preview.storage.providerId,
        shareUrl: requiredText(input.shareUrl, 'shareUrl'),
        shareTitle: String(input.shareTitle || '').trim() || null,
        seasonNumber: preview.plan.seasonNumber,
        selectedFiles,
        estimatedBytes: preview.plan.estimatedBytes,
      },
    });

    try {
      const reservation = await episodes.reserveWrites({
        storageId,
        seasonNumber: preview.plan.seasonNumber,
        eventId: event.id,
        episodeNumbers: selectedFiles.map((file) => file.episodeNumber),
      });
      if (reservation.blocked.length > 0
          || reservation.claimed.length !== selectedFiles.length) {
        await episodes.releaseUnwrittenClaims({ eventId: event.id, writeAttempted: false });
        const skipped = await events.transition({
          id: event.id,
          status: 'skipped',
        });
        return {
          queued: false,
          reason: 'episode_write_claimed',
          event: skipped,
          preview,
        };
      }
      return { queued: true, event, preview };
    } catch (error) {
      await episodes.releaseUnwrittenClaims({ eventId: event.id, writeAttempted: false });
      await events.transition({
        id: event.id,
        status: 'failed',
        error: 'Episode write reservation failed',
      });
      throw error;
    }
  }

  async function processEventUnlocked(eventIdValue) {
    const eventId = positiveId(eventIdValue, 'eventId');
    const current = await events.getById(eventId);
    if (!current) throw new Error('event ' + eventId + ' not found');
    if (current.status !== 'pending' || current.kind !== 'new_ep') {
      const error = new Error('event is not a pending episode follow-up');
      error.status = 409;
      error.code = 'EVENT_NOT_PROCESSABLE';
      throw error;
    }
    let event = await events.transition({ id: eventId, status: 'processing' });
    let stage = 'preflight';
    let writeAttempted = false;

    async function fail(cause) {
      if (writeAttempted) await episodes.markWritesUncertain({ eventId });
      else await episodes.releaseUnwrittenClaims({ eventId, writeAttempted: false });
      const errorCode = safeErrorCode(cause);
      const terminalStatus = cause?.isPluginError !== true
        && ['DESTINATION_CONFLICT', 'EPISODE_WRITE_CLAIMED'].includes(cause?.code)
        ? 'skipped'
        : 'failed';
      event = await events.transition({
        id: eventId,
        status: terminalStatus,
        ...(terminalStatus === 'failed'
          ? { error: stage + ' failed (' + errorCode + ')' }
          : {}),
      });
      const notification = await publishStatus(event, terminalStatus, {
        eventId,
        showId: event.showId,
        kind: event.kind,
        status: event.status,
      });
      return { ok: false, event, stage, errorCode, ...notification };
    }

    try {
      const payload = event.payload || {};
      const storageId = positiveId(payload.storageId, 'payload.storageId');
      const seasonNumber = positiveId(payload.seasonNumber, 'payload.seasonNumber');
      const shareUrl = requiredText(payload.shareUrl, 'payload.shareUrl');
      const expectedFiles = Array.isArray(payload.selectedFiles) ? payload.selectedFiles : [];
      if (expectedFiles.length === 0) throw new Error('event has no selected files');
      const expectedEpisodeNumbers = expectedFiles.map((file) => positiveId(
        file.episodeNumber,
        'selected episodeNumber',
      ));
      if (new Set(expectedEpisodeNumbers).size !== expectedEpisodeNumbers.length) {
        throw new Error('event contains duplicate episode selections');
      }

      const show = await shows.getById(event.showId);
      const storage = await episodes.getStorageById(storageId);
      if (!show || !storage || storage.showId !== event.showId || !storage.enabled) {
        throw new Error('event show or storage is unavailable');
      }
      if (storage.providerId !== payload.providerId) {
        throw new Error('event storage provider changed');
      }
      const storagePlugins = listPlugins({
        domain: 'storage',
        capability: 'listSharedFiles',
        enabledOnly: true,
      });
      const storagePlugin = storagePlugins.find((plugin) => plugin.id === storage.providerId);
      if (!storagePlugin) throw new Error('storage plugin is not enabled');

      let claims = await episodes.listWriteClaims(eventId);
      if (claims.length === 0) {
        const reservation = await episodes.reserveWrites({
          storageId,
          seasonNumber,
          eventId,
          episodeNumbers: expectedEpisodeNumbers,
        });
        if (reservation.blocked.length > 0
            || reservation.claimed.length !== expectedEpisodeNumbers.length) {
          const error = new Error('one or more episodes are claimed by another event');
          error.code = 'EPISODE_WRITE_CLAIMED';
          throw error;
        }
        claims = await episodes.listWriteClaims(eventId);
      }
      const claimedEpisodeNumbers = new Set(claims.map((claim) => claim.episodeNumber));
      if (claims.length !== expectedEpisodeNumbers.length
          || claimedEpisodeNumbers.size !== expectedEpisodeNumbers.length
          || claims.some((claim) => claim.storageId !== storageId
            || claim.seasonNumber !== seasonNumber
            || claim.status !== 'reserved'
            || !expectedEpisodeNumbers.includes(claim.episodeNumber))) {
        const error = new Error('event write claims are incomplete or require review');
        error.code = 'EPISODE_WRITE_CLAIMED';
        throw error;
      }

      const sourceListing = await invoke(storage.providerId, {
        capability: 'listSharedFiles',
        input: { shareUrl },
        context: { source: 'followup-process', correlationId: event.correlationId },
      });
      const sourceFiles = requireCompleteListing(sourceListing, 'share');
      const freshSelection = expectedFiles.map((expected) => {
        const expectedSize = numericSize(expected.size);
        const expectedFileId = String(expected.id || '').trim();
        if (!expectedFileId) {
          const error = new Error('event has a selected file without a provider id');
          error.code = 'INVALID_EVENT_SELECTION';
          throw error;
        }
        const candidates = sourceFiles.filter((file) => {
          if (file.isDir || String(file.name || file.fileName || '') !== expected.name) return false;
          if (file.id == null || String(file.id) !== expectedFileId) return false;
          if (expectedSize == null || numericSize(file.size) !== expectedSize) return false;
          if (expected.path && file.path !== expected.path) return false;
          const parsed = episodeFromVideoFile(file);
          return parsed?.seasonNumber === seasonNumber
            && parsed.episodeNumber === Number(expected.episodeNumber);
        });
        if (candidates.length !== 1 || candidates[0].id == null) {
          const error = new Error('a selected share file changed or is ambiguous');
          error.code = 'SHARE_SELECTION_CHANGED';
          throw error;
        }
        return candidates[0];
      });

      const seasonDirectory = 'Season ' + String(seasonNumber).padStart(2, '0');
      const destinationPath = joinCloudPath(storage.rootPath, seasonDirectory);
      const canonicalFiles = expectedFiles.map((file) => {
        const extension = String(file.name).match(/\.[^.]+$/)?.[0];
        return {
          ...file,
          canonicalName: formatCanonicalEpisodeName({
            showName: show.name,
            seasonNumber,
            episodeNumber: file.episodeNumber,
            quality: file.quality,
            extension,
          }),
        };
      });

      stage = 'destination-prepare';
      await invoke(storage.providerId, {
        capability: 'mkdir',
        input: { path: destinationPath },
        context: { source: 'followup-process', correlationId: event.correlationId },
      });
      const beforeListing = await invoke(storage.providerId, {
        capability: 'list',
        input: { path: destinationPath, options: { recursive: true } },
        context: { source: 'followup-process', correlationId: event.correlationId },
      });
      const beforeFiles = requireCompleteListing(beforeListing, 'destination');
      const beforeFileKeys = new Set(beforeFiles
        .filter((file) => !file.isDir)
        .map((file) => storageFileKey(file, destinationPath)));
      const occupiedNames = new Set(beforeFiles.filter((file) => !file.isDir)
        .map((file) => cloudBasename(file)));
      if (canonicalFiles.some((file) => occupiedNames.has(file.name)
          || occupiedNames.has(file.canonicalName))) {
        const error = new Error('destination contains a selected or canonical filename');
        error.code = 'DESTINATION_CONFLICT';
        throw error;
      }

      stage = 'storage-save';
      writeAttempted = true;
      await invoke(storage.providerId, {
        capability: 'save',
        input: { shareUrl, destinationPath, selection: freshSelection },
        context: { source: 'followup-process', correlationId: event.correlationId },
      });

      stage = 'save-verification';
      const savedListing = await invoke(storage.providerId, {
        capability: 'list',
        input: { path: destinationPath, options: { recursive: true } },
        context: { source: 'followup-process', correlationId: event.correlationId },
      });
      const savedFiles = requireCompleteListing(savedListing, 'saved-file');
      const newlySavedFiles = savedFiles.filter((file) => !file.isDir
        && !beforeFileKeys.has(storageFileKey(file, destinationPath)));
      if (newlySavedFiles.length !== canonicalFiles.length) {
        const error = new Error('storage provider saved an unexpected number of files');
        error.code = 'SAVE_SELECTION_MISMATCH';
        throw error;
      }
      const filesToOrganize = canonicalFiles.map((expected) => {
        const matches = newlySavedFiles.filter((file) =>
          cloudBasename(file) === expected.name
          && numericSize(file.size) === numericSize(expected.size));
        if (matches.length !== 1 || !matches[0].path) {
          const error = new Error('saved file could not be uniquely verified');
          error.code = 'SAVE_VERIFICATION_FAILED';
          throw error;
        }
        return { expected, file: matches[0] };
      });

      stage = 'storage-move';
      for (const item of filesToOrganize) {
        const targetPath = joinCloudPath(destinationPath, item.expected.name);
        if (item.file.path !== targetPath) {
          await invoke(storage.providerId, {
            capability: 'move',
            input: { sourcePath: item.file.path, destinationPath: targetPath },
            context: { source: 'followup-process', correlationId: event.correlationId },
          });
        }
      }

      stage = 'storage-rename';
      const renameItems = filesToOrganize
        .filter((item) => item.expected.name !== item.expected.canonicalName)
        .map((item) => ({
          path: joinCloudPath(destinationPath, item.expected.name),
          newName: item.expected.canonicalName,
        }));
      if (renameItems.length) {
        await invoke(storage.providerId, {
          capability: 'renameMany',
          input: { items: renameItems },
          context: { source: 'followup-process', correlationId: event.correlationId },
        });
      }

      stage = 'final-verification';
      const finalListing = await invoke(storage.providerId, {
        capability: 'list',
        input: { path: destinationPath, options: { recursive: true } },
        context: { source: 'followup-process', correlationId: event.correlationId },
      });
      const finalFiles = requireCompleteListing(finalListing, 'final destination');
      const verified = canonicalFiles.map((expected) => {
        const matches = finalFiles.filter((file) => !file.isDir
          && cloudBasename(file) === expected.canonicalName
          && numericSize(file.size) === numericSize(expected.size));
        if (matches.length !== 1 || !matches[0].path) {
          const error = new Error('canonical file could not be uniquely verified');
          error.code = 'FINAL_VERIFICATION_FAILED';
          throw error;
        }
        return { expected, file: matches[0] };
      });

      stage = 'catalog-sync';
      const assets = [];
      for (const item of verified) {
        const episode = await episodes.upsertEpisode({
          showId: event.showId,
          seasonNumber,
          episodeNumber: item.expected.episodeNumber,
        });
        assets.push({
          episodeId: episode.id,
          assetKey: relativeStoragePath(storage.rootPath, item.file.path),
          relativePath: relativeStoragePath(storage.rootPath, item.file.path),
          fileName: cloudBasename(item.file),
          fileSize: numericSize(item.file.size),
          fileMtime: mtimeValue(item.file.mtime),
          quality: detectQuality(cloudBasename(item.file)),
        });
      }
      await episodes.syncAssets({
        storageId,
        scanId: randomUUID(),
        assets,
        completeSnapshot: false,
      });

      stage = 'media-index';
      const indexers = listPlugins({
        domain: 'indexer',
        capability: 'reindex',
        enabledOnly: true,
      });
      let indexResult = { skipped: true, reason: 'no_enabled_indexer' };
      if (indexers.length) {
        indexResult = await invoke(indexers[0].id, {
          capability: 'reindex',
          input: {
            showId: event.showId,
            storageId,
            path: storage.rootPath,
            seasonNumber,
          },
          context: { source: 'followup-process', correlationId: event.correlationId },
        });
        if (!indexResult || indexResult.ok !== true) {
          const error = new Error('media indexer did not confirm reindex success');
          error.code = 'INDEXER_UNCONFIRMED';
          throw error;
        }
      }

      stage = 'event-finalize';
      event = await events.finalizeProcessed({
        id: eventId,
        storageId,
        seasonNumber,
        episodeNumbers: expectedEpisodeNumbers,
      });
      const notification = await publishStatus(event, 'processed', {
        eventId,
        showId: event.showId,
        showName: show.name,
        kind: event.kind,
        status: event.status,
        seasonNumber,
        episodeNumbers: expectedEpisodeNumbers,
      });
      return {
        ok: true,
        event,
        episodeNumbers: expectedEpisodeNumbers,
        indexResult,
        ...notification,
      };
    } catch (error) {
      const result = await fail(error);
      return result;
    }
  }

  async function processEvent(eventIdValue) {
    const eventId = positiveId(eventIdValue, 'eventId');
    return withEventLock(eventId, () => processEventUnlocked(eventId));
  }

  async function recoverInterruptedEvent(eventIdValue, input = {}) {
    const eventId = positiveId(eventIdValue, 'eventId');
    const action = String(input.action || '');
    if (!['complete', 'retry_after_review'].includes(action)) {
      throw new TypeError('action must be complete or retry_after_review');
    }
    if (input.confirmNoActiveWorker !== true) {
      throw new TypeError('confirmNoActiveWorker must be true before recovery');
    }
    if (action === 'complete' && input.confirmOutputsMatch !== true) {
      throw new TypeError('confirmOutputsMatch must be true before completion');
    }
    if (action === 'retry_after_review' && input.confirmNoOutput !== true) {
      throw new TypeError('confirmNoOutput must be true before retry can be enabled');
    }

    return withEventLock(eventId, async () => {
      let event = await events.getById(eventId);
      if (!event) throw new Error('event ' + eventId + ' not found');
      if (event.kind !== 'new_ep' || !['processing', 'failed'].includes(event.status)) {
        const error = new Error('only interrupted follow-up events can be reviewed');
        error.status = 409;
        error.code = 'EVENT_NOT_REVIEWABLE';
        throw error;
      }

      const payload = event.payload || {};
      const storageId = positiveId(payload.storageId, 'payload.storageId');
      const seasonNumber = positiveId(payload.seasonNumber, 'payload.seasonNumber');
      const expectedFiles = Array.isArray(payload.selectedFiles) ? payload.selectedFiles : [];
      if (!expectedFiles.length) {
        const error = new Error('event has no selected files to review');
        error.status = 409;
        error.code = 'INVALID_EVENT_SELECTION';
        throw error;
      }
      const expectedEpisodeNumbers = expectedFiles.map((file) => positiveId(
        file.episodeNumber,
        'selected episodeNumber',
      ));
      if (new Set(expectedEpisodeNumbers).size !== expectedEpisodeNumbers.length) {
        const error = new Error('event contains duplicate episode selections');
        error.status = 409;
        error.code = 'INVALID_EVENT_SELECTION';
        throw error;
      }

      const show = await shows.getById(event.showId);
      const storage = await episodes.getStorageById(storageId);
      if (!show || !storage || storage.showId !== event.showId || !storage.enabled
          || storage.providerId !== payload.providerId) {
        const error = new Error('event show or storage changed and requires manual review');
        error.status = 409;
        error.code = 'RECOVERY_CONFIGURATION_CHANGED';
        throw error;
      }

      const claims = await episodes.listWriteClaims(eventId);
      const expectedClaimStatus = event.status === 'processing'
        ? (claim) => claim.status === 'reserved'
        : (claim) => claim.status === 'uncertain'
          || (claim.status === 'reserved'
            && String(event.lastError || '').startsWith(REVIEWED_NO_OUTPUT_ERROR));
      const claimsMatch = claims.length === expectedEpisodeNumbers.length
        && claims.every((claim) => claim.storageId === storageId
          && claim.seasonNumber === seasonNumber
          && expectedEpisodeNumbers.includes(claim.episodeNumber)
          && expectedClaimStatus(claim));
      if (event.status === 'failed' && !claims.length) {
        const error = new Error('failed event has no unresolved write claim');
        error.status = 409;
        error.code = 'EVENT_NOT_REVIEWABLE';
        throw error;
      }
      if (claims.length > 0 && !claimsMatch) {
        const error = new Error('event write claims require manual reconciliation');
        error.status = 409;
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }
      if (action === 'complete' && !claimsMatch) {
        const error = new Error('all selected episodes must have a reserved write claim before completion');
        error.status = 409;
        error.code = 'WRITE_CLAIMS_CHANGED';
        throw error;
      }

      const storagePlugin = listPlugins({
        domain: 'storage',
        capability: 'list',
        enabledOnly: true,
      }).find((plugin) => plugin.id === storage.providerId);
      if (!storagePlugin) {
        const error = new Error('storage plugin is not enabled');
        error.status = 409;
        error.code = 'RECOVERY_STORAGE_UNAVAILABLE';
        throw error;
      }

      const seasonDirectory = 'Season ' + String(seasonNumber).padStart(2, '0');
      const destinationPath = joinCloudPath(storage.rootPath, seasonDirectory);
      const expectedOutputs = expectedFiles.map((file) => {
        const sourceName = requiredText(file.name, 'selected file name');
        const extension = sourceName.match(/\.[^.]+$/)?.[0];
        return {
          ...file,
          name: sourceName,
          size: numericSize(file.size),
          canonicalName: formatCanonicalEpisodeName({
            showName: show.name,
            seasonNumber,
            episodeNumber: file.episodeNumber,
            quality: file.quality,
            extension,
          }),
        };
      });
      if (expectedOutputs.some((file) => file.size == null)) {
        const error = new Error('event file sizes are unavailable for safe recovery');
        error.status = 409;
        error.code = 'INVALID_EVENT_SELECTION';
        throw error;
      }

      await invoke(storage.providerId, {
        capability: 'mkdir',
        input: { path: destinationPath },
        context: { source: 'followup-recovery', correlationId: event.correlationId },
      });
      const listing = await invoke(storage.providerId, {
        capability: 'list',
        input: { path: destinationPath, options: { recursive: true } },
        context: { source: 'followup-recovery', correlationId: event.correlationId },
      });
      let files = requireCompleteListing(listing, 'recovery destination');

      if (action === 'retry_after_review') {
        const possibleOutputNames = new Set(expectedOutputs.flatMap((file) => [
          file.name,
          file.canonicalName,
        ]));
        if (files.some((file) => !file.isDir && possibleOutputNames.has(cloudBasename(file)))) {
          const error = new Error(
            'selected or canonical media files are present; finish recovery or inspect the destination manually',
          );
          error.status = 409;
          error.code = 'RECOVERY_OUTPUT_PRESENT';
          throw error;
        }
        const reviewedInput = {
          id: eventId,
          storageId,
          seasonNumber,
          episodeNumbers: expectedEpisodeNumbers,
        };
        event = event.status === 'processing'
          ? await events.markInterruptedRetryable(reviewedInput)
          : await events.markFailedRetryableAfterReview(reviewedInput);
        const notification = await publishStatus(event, 'failed', {
          eventId,
          showId: event.showId,
          kind: event.kind,
          status: event.status,
          recovery: 'confirmed_no_output',
        });
        return { ok: true, event, resolution: 'retryable', ...notification };
      }

      const selected = expectedOutputs.map((expected) => {
        const matches = files.filter((file) => !file.isDir
          && numericSize(file.size) === expected.size
          && [expected.name, expected.canonicalName].includes(cloudBasename(file)));
        if (matches.length !== 1 || !matches[0].path) {
          const error = new Error(
            'the destination does not contain one uniquely verifiable file for every selected episode',
          );
          error.status = 409;
          error.code = 'RECOVERY_INCOMPLETE';
          throw error;
        }
        return { expected, file: matches[0] };
      });
      if (new Set(selected.map((item) => item.file.path)).size !== selected.length) {
        const error = new Error('selected recovery files are ambiguous');
        error.status = 409;
        error.code = 'RECOVERY_AMBIGUOUS';
        throw error;
      }

      const selectedPaths = new Set(selected.map((item) => item.file.path));
      const canonicalNames = new Set(expectedOutputs.map((file) => file.canonicalName));
      if (files.some((file) => !file.isDir
          && canonicalNames.has(cloudBasename(file))
          && !selectedPaths.has(file.path))) {
        const error = new Error('a canonical destination name is already occupied');
        error.status = 409;
        error.code = 'RECOVERY_DESTINATION_CONFLICT';
        throw error;
      }

      for (const item of selected) {
        const targetName = cloudBasename(item.file);
        const targetPath = joinCloudPath(destinationPath, targetName);
        const targetOccupied = files.some((file) => !file.isDir
          && file.path === targetPath && file.path !== item.file.path);
        if (targetOccupied) {
          const error = new Error('a source filename is already occupied in the recovery destination');
          error.status = 409;
          error.code = 'RECOVERY_DESTINATION_CONFLICT';
          throw error;
        }
        if (item.file.path !== targetPath) {
          await invoke(storage.providerId, {
            capability: 'move',
            input: { sourcePath: item.file.path, destinationPath: targetPath },
            context: { source: 'followup-recovery', correlationId: event.correlationId },
          });
        }
        item.targetName = targetName;
        item.targetPath = targetPath;
      }

      const renameItems = selected
        .filter((item) => item.targetName !== item.expected.canonicalName)
        .map((file) => ({
          path: file.targetPath,
          newName: file.expected.canonicalName,
        }));
      if (renameItems.length) {
        await invoke(storage.providerId, {
          capability: 'renameMany',
          input: { items: renameItems },
          context: { source: 'followup-recovery', correlationId: event.correlationId },
        });
      }

      const finalListing = await invoke(storage.providerId, {
        capability: 'list',
        input: { path: destinationPath, options: { recursive: true } },
        context: { source: 'followup-recovery', correlationId: event.correlationId },
      });
      files = requireCompleteListing(finalListing, 'recovered destination');
      const verified = expectedOutputs.map((expected) => {
        const matches = files.filter((file) => !file.isDir
          && cloudBasename(file) === expected.canonicalName
          && numericSize(file.size) === expected.size);
        if (matches.length !== 1 || !matches[0].path) {
          const error = new Error('recovered canonical files could not be uniquely verified');
          error.status = 409;
          error.code = 'RECOVERY_VERIFICATION_FAILED';
          throw error;
        }
        return { expected, file: matches[0] };
      });

      const assets = [];
      for (const item of verified) {
        const episode = await episodes.upsertEpisode({
          showId: event.showId,
          seasonNumber,
          episodeNumber: item.expected.episodeNumber,
        });
        assets.push({
          episodeId: episode.id,
          assetKey: relativeStoragePath(storage.rootPath, item.file.path),
          relativePath: relativeStoragePath(storage.rootPath, item.file.path),
          fileName: cloudBasename(item.file),
          fileSize: item.expected.size,
          fileMtime: mtimeValue(item.file.mtime),
          quality: detectQuality(cloudBasename(item.file)),
        });
      }
      await episodes.syncAssets({
        storageId,
        scanId: randomUUID(),
        assets,
        completeSnapshot: false,
      });

      const indexers = listPlugins({
        domain: 'indexer',
        capability: 'reindex',
        enabledOnly: true,
      });
      let indexResult = { skipped: true, reason: 'no_enabled_indexer' };
      if (indexers.length) {
        indexResult = await invoke(indexers[0].id, {
          capability: 'reindex',
          input: {
            showId: event.showId,
            storageId,
            path: storage.rootPath,
            seasonNumber,
          },
          context: { source: 'followup-recovery', correlationId: event.correlationId },
        });
        if (!indexResult || indexResult.ok !== true) {
          const error = new Error('media indexer did not confirm recovery reindex success');
          error.status = 409;
          error.code = 'INDEXER_UNCONFIRMED';
          throw error;
        }
      }

      const finalize = event.status === 'processing'
        ? events.finalizeProcessed
        : events.finalizeReviewedProcessed;
      event = await finalize({
        id: eventId,
        storageId,
        seasonNumber,
        episodeNumbers: expectedEpisodeNumbers,
      });
      const notification = await publishStatus(event, 'processed', {
        eventId,
        showId: event.showId,
        showName: show.name,
        kind: event.kind,
        status: event.status,
        seasonNumber,
        episodeNumbers: expectedEpisodeNumbers,
        recovery: 'completed_after_verification',
      });
      return {
        ok: true,
        event,
        episodeNumbers: expectedEpisodeNumbers,
        indexResult,
        resolution: 'processed',
        ...notification,
      };
    });
  }

  return Object.freeze({
    previewShare,
    queueShare,
    processEvent,
    recoverInterruptedEvent,
  });
}

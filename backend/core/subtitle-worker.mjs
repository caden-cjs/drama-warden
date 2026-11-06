import path from 'node:path';
import { normalizeSubtitleDownload, subtitleFileName } from './subtitle-content.mjs';

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt']);

function safeErrorCode(error) {
  const code = String(error?.code || 'SUBTITLE_JOB_FAILED');
  return /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'SUBTITLE_JOB_FAILED';
}

function candidateNumbers(candidate) {
  const explicitSeason = candidate?.seasonNumber == null ? Number.NaN : Number(candidate.seasonNumber);
  const explicitEpisode = candidate?.episodeNumber == null ? Number.NaN : Number(candidate.episodeNumber);
  const text = [candidate?.fileName, candidate?.release, candidate?.title]
    .filter(Boolean).join(' ');
  const seasonEpisode = text.match(/[Ss](\d{1,2})\s*[Ee][Pp]?(\d{1,3})/);
  if (seasonEpisode) {
    return { seasonNumber: Number(seasonEpisode[1]), episodeNumber: Number(seasonEpisode[2]) };
  }
  const episode = text.match(/(?:^|[^A-Za-z])(?:episode|ep|e)\s*0*(\d{1,3})(?:[^\d]|$)/i)
    || text.match(/第\s*0*(\d{1,3})\s*集/);
  if (Number.isSafeInteger(explicitSeason) && explicitSeason >= 0
      && Number.isSafeInteger(explicitEpisode) && explicitEpisode > 0) {
    return { seasonNumber: explicitSeason, episodeNumber: explicitEpisode };
  }
  if (Number.isSafeInteger(explicitEpisode) && explicitEpisode > 0) {
    return { seasonNumber: Number.isSafeInteger(explicitSeason) ? explicitSeason : null, episodeNumber: explicitEpisode };
  }
  if (episode) return { seasonNumber: null, episodeNumber: Number(episode[1]) };
  return null;
}

function candidateMatches(candidate, job) {
  const numbers = candidateNumbers(candidate);
  if (!numbers || numbers.episodeNumber !== job.episodeNumber) return false;
  if (numbers.seasonNumber != null && numbers.seasonNumber !== job.seasonNumber) return false;
  return job.seasonNumber === 1 || numbers.seasonNumber === job.seasonNumber;
}

function subtitleBaseName(videoName) {
  const name = String(videoName || '');
  if (!name || name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('video asset has an unsafe file name');
  }
  const extension = path.posix.extname(name);
  if (!extension) throw new Error('video asset has no file extension');
  return name.slice(0, -extension.length);
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSubtitleWorker({
  repository,
  listPlugins,
  invoke,
  logger = console,
  intervalMs = 30_000,
  maxJobsPerTick = 1,
} = {}) {
  if (!repository || typeof listPlugins !== 'function' || typeof invoke !== 'function') {
    throw new TypeError('subtitle repository and plugin ports are required');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000
      || !Number.isSafeInteger(maxJobsPerTick) || maxJobsPerTick < 1 || maxJobsPerTick > 10) {
    throw new TypeError('subtitle worker interval or job limit is invalid');
  }

  let timer = null;
  let processing = false;
  let stopped = true;
  let idlePromise = Promise.resolve();

  async function listSidecarCandidates(context) {
    const asset = context.assets[0];
    const parentPath = path.posix.dirname(asset.relativePath);
    const listing = await invoke(context.storage.providerId, {
      capability: 'list',
      input: { path: parentPath, options: { recursive: false, limit: 200 } },
      context: { source: 'subtitle-worker', correlationId: 'subtitle-job-' + context.job.id },
    });
    if (listing?.truncated) throw errorWithCode('storage listing is incomplete', 'INCOMPLETE_STORAGE_LISTING');
    return listing?.files || [];
  }

  async function processJob(job) {
    const context = await repository.getContext(job.id);
    if (!context?.show || !context.storage || !context.storage.enabled) {
      throw errorWithCode('subtitle job target is unavailable', 'SUBTITLE_TARGET_UNAVAILABLE');
    }
    if (context.assets.length === 0) {
      await repository.skip(job.id, 'VIDEO_ASSET_NOT_FOUND', job.claimToken);
      return;
    }
    if (context.assets.length !== 1) {
      await repository.skip(job.id, 'VIDEO_ASSET_AMBIGUOUS', job.claimToken);
      return;
    }
    const storagePlugin = listPlugins({
      kind: 'storage-provider',
      capability: 'writeSidecar',
      enabledOnly: true,
    }).find((plugin) => plugin.id === context.storage.providerId);
    if (!storagePlugin) throw errorWithCode('storage provider cannot write subtitle sidecars', 'SIDECAR_WRITE_UNSUPPORTED');

    const asset = context.assets[0];
    const baseName = subtitleBaseName(asset.fileName);
    const existing = await listSidecarCandidates(context);
    if (existing.some((file) => !file.isDir && SUBTITLE_EXTENSIONS.has(path.posix.extname(file.name || '').toLowerCase())
        && path.posix.basename(file.name, path.posix.extname(file.name)).toLocaleLowerCase()
          === baseName.toLocaleLowerCase())) {
      await repository.skip(job.id, 'SUBTITLE_ALREADY_EXISTS', job.claimToken);
      return;
    }

    const subtitleProviders = listPlugins({ kind: 'subtitle-provider', enabledOnly: true })
      .filter((plugin) => plugin.capabilities.includes('search') && plugin.capabilities.includes('download'));
    if (subtitleProviders.length === 0) throw errorWithCode('no subtitle provider is enabled', 'NO_SUBTITLE_PROVIDER');
    const query = `${context.show.name} S${String(job.seasonNumber).padStart(2, '0')}E${String(job.episodeNumber).padStart(2, '0')}`;
    let downloaded = null;
    let selectedProviderId = null;
    let providerErrors = 0;
    let searchSuccesses = 0;
    let lastDownloadError = null;
    for (const provider of subtitleProviders) {
      try {
        const found = await invoke(provider.id, {
          capability: 'search',
          input: {
            query,
            languages: job.languages,
            seasonNumber: job.seasonNumber,
            episodeNumber: job.episodeNumber,
            limit: 20,
          },
          context: { source: 'subtitle-worker', correlationId: 'subtitle-job-' + job.id },
        });
        if (!Array.isArray(found)) throw errorWithCode('subtitle provider returned an invalid result list', 'INVALID_SUBTITLE_RESPONSE');
        searchSuccesses += 1;
        for (const candidate of found.filter((item) => item?.id != null && candidateMatches(item, job))) {
          try {
            const response = await invoke(provider.id, {
              capability: 'download',
              input: { candidateId: String(candidate.id) },
              context: { source: 'subtitle-worker', correlationId: 'subtitle-job-' + job.id },
            });
            downloaded = normalizeSubtitleDownload(response, job);
            selectedProviderId = provider.id;
            break;
          } catch (error) {
            lastDownloadError = error;
            logger.warn?.('[subtitle-worker] candidate download failed', {
              providerId: provider.id,
              errorCode: safeErrorCode(error),
            });
          }
        }
      } catch (error) {
        providerErrors += 1;
        logger.warn?.('[subtitle-worker] provider search failed', {
          providerId: provider.id,
          errorCode: safeErrorCode(error),
        });
      }
      if (downloaded) break;
    }
    if (!downloaded) {
      if (lastDownloadError) throw lastDownloadError;
      if (providerErrors === subtitleProviders.length && searchSuccesses === 0) {
        throw errorWithCode('all subtitle providers failed', 'ALL_SUBTITLE_PROVIDERS_FAILED');
      }
      await repository.skip(job.id, 'NO_MATCHING_SUBTITLE', job.claimToken);
      return;
    }

    const extension = path.posix.extname(subtitleFileName(downloaded.fileName)).toLowerCase();
    const outputName = subtitleFileName(baseName + extension);
    await repository.markWriteStarted(job.id, selectedProviderId, job.claimToken);
    const result = await invoke(context.storage.providerId, {
      capability: 'writeSidecar',
      input: {
        videoPath: asset.relativePath,
        fileName: outputName,
        content: downloaded.content,
      },
      context: { source: 'subtitle-worker', correlationId: 'subtitle-job-' + job.id },
    });
    if (result?.ok !== true || !result.path) {
      throw errorWithCode('storage provider did not confirm the subtitle write', 'SIDECAR_WRITE_UNCONFIRMED');
    }
    await repository.complete(job.id, {
      providerId: selectedProviderId,
      outputPath: result.path,
      claimToken: job.claimToken,
    });
  }

  async function tick() {
    if (processing || stopped) return;
    processing = true;
    idlePromise = (async () => {
      for (let count = 0; count < maxJobsPerTick && !stopped; count += 1) {
        const job = await repository.claimNext();
        if (!job) break;
        try {
          await processJob(job);
        } catch (error) {
          try {
            await repository.fail(job.id, safeErrorCode(error), job.claimToken);
          } catch (stateError) {
            logger.error?.('[subtitle-worker] could not persist job failure', {
              jobId: job.id,
              errorCode: safeErrorCode(stateError),
            });
          }
          logger.warn?.('[subtitle-worker] job failed', {
            jobId: job.id,
            errorCode: safeErrorCode(error),
          });
        }
      }
    })().catch((error) => {
      logger.error?.('[subtitle-worker] worker tick failed', { errorCode: safeErrorCode(error) });
    }).finally(() => {
      processing = false;
    });
    await idlePromise;
  }

  return Object.freeze({
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    async waitForIdle() {
      await idlePromise;
    },
    status() {
      return { enabled: !stopped, processing, intervalMs };
    },
  });
}

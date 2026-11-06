import { randomUUID } from 'node:crypto';
import { detectQuality, episodeFromVideoFile } from './media-naming.mjs';

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(field + ' must be a positive integer');
  }
  return id;
}

function normalizedCloudPath(value, label) {
  const rawPath = String(value || '').replace(/\/{2,}/g, '/');
  const absolute = rawPath.startsWith('/');
  const segments = rawPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    const error = new Error(label + ' contains an unsafe path segment');
    error.code = 'INVALID_STORAGE_PATH';
    throw error;
  }
  return (absolute ? '/' : '') + segments.join('/');
}

function relativeStoragePath(rootPath, filePath) {
  const root = normalizedCloudPath(rootPath, 'storage root');
  const current = normalizedCloudPath(filePath, 'storage file path');
  if (!current) throw new Error('storage provider returned a file without a path');
  if (!root) return current.replace(/^\//, '');
  if (current === root) throw new Error('storage provider returned a file path equal to its root');
  const prefix = root === '/' ? '/' : root + '/';
  if (!current.startsWith(prefix)) {
    const error = new Error('storage provider returned a file outside its configured root');
    error.code = 'PATH_OUTSIDE_ROOT';
    throw error;
  }
  return current.slice(prefix.length);
}

function basename(file) {
  const name = String(file?.name || '');
  if (name) return name;
  const filePath = String(file?.path || '');
  return filePath.slice(filePath.lastIndexOf('/') + 1);
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

function episodeSeason(file, relativePath, parsed) {
  const name = basename(file);
  const explicitSeason = name.match(/S(\d+)E\d+/i);
  if (explicitSeason) return parsed.seasonNumber;
  const pathSeason = relativePath.split('/').slice(0, -1).reverse()
    .map((segment) => segment.match(/^Season[\s._-]*(\d+)$/i))
    .find(Boolean);
  return pathSeason ? Number(pathSeason[1]) : parsed.seasonNumber;
}

export function createStorageCatalogService({
  shows,
  episodes,
  listPlugins,
  invoke,
} = {}) {
  if (!shows || typeof shows.getById !== 'function') {
    throw new TypeError('shows repository is required');
  }
  if (!episodes || typeof episodes.getStorageById !== 'function'
      || typeof episodes.upsertSeason !== 'function'
      || typeof episodes.upsertEpisode !== 'function'
      || typeof episodes.syncAssets !== 'function') {
    throw new TypeError('episode repository is missing storage catalog operations');
  }
  if (typeof listPlugins !== 'function' || typeof invoke !== 'function') {
    throw new TypeError('plugin listing and invocation functions are required');
  }

  async function scanStorage({ showId: showIdValue, storageId: storageIdValue } = {}) {
    const showId = positiveId(showIdValue, 'showId');
    const storageId = positiveId(storageIdValue, 'storageId');
    const show = await shows.getById(showId);
    if (!show) throw new Error('show ' + showId + ' not found');
    const storage = await episodes.getStorageById(storageId);
    if (!storage || storage.showId !== showId) {
      const error = new Error('storage ' + storageId + ' was not found for show ' + showId);
      error.status = 404;
      error.code = 'STORAGE_NOT_FOUND';
      throw error;
    }
    if (!storage.enabled) {
      const error = new Error('storage ' + storageId + ' is disabled');
      error.status = 409;
      error.code = 'STORAGE_DISABLED';
      throw error;
    }
    const providers = listPlugins({
      domain: 'storage',
      capability: 'list',
      enabledOnly: true,
    });
    if (!providers.some((plugin) => plugin.id === storage.providerId)) {
      const error = new Error('storage plugin is not enabled: ' + storage.providerId);
      error.status = 422;
      error.code = 'STORAGE_PROVIDER_UNAVAILABLE';
      throw error;
    }

    const scanId = randomUUID();
    const listing = await invoke(storage.providerId, {
      capability: 'list',
      input: { path: storage.rootPath, options: { recursive: true } },
      context: { source: 'storage-catalog-scan', showId, storageId, correlationId: scanId },
    });
    if (!listing || !Array.isArray(listing.files)
        || (listing.truncated !== true && listing.truncated !== false)) {
      const error = new Error('storage provider returned an invalid listing');
      error.code = 'INVALID_STORAGE_LISTING';
      throw error;
    }

    const assets = [];
    let ignoredFileCount = 0;
    const ensuredSeasons = new Set();
    for (const file of listing.files) {
      if (file?.isDir) continue;
      const parsed = episodeFromVideoFile(file);
      if (!parsed) {
        ignoredFileCount += 1;
        continue;
      }
      const relativePath = relativeStoragePath(storage.rootPath, file.path);
      const seasonNumber = episodeSeason(file, relativePath, parsed);
      const episodeNumber = Number(parsed.episodeNumber);
      if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0
          || !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) {
        ignoredFileCount += 1;
        continue;
      }
      if (!ensuredSeasons.has(seasonNumber)) {
        await episodes.upsertSeason({ showId, seasonNumber });
        ensuredSeasons.add(seasonNumber);
      }
      const episode = await episodes.upsertEpisode({ showId, seasonNumber, episodeNumber });
      assets.push({
        episodeId: episode.id,
        assetKey: relativePath,
        relativePath,
        fileName: basename(file),
        fileSize: numericSize(file.size),
        fileMtime: mtimeValue(file.mtime),
        quality: detectQuality(basename(file)),
      });
    }

    const completeSnapshot = listing.truncated === false;
    const result = await episodes.syncAssets({
      storageId,
      scanId,
      assets,
      completeSnapshot,
    });
    return {
      showId,
      storageId,
      scanId,
      listedEntryCount: listing.files.length,
      visibleAssetCount: assets.length,
      ignoredFileCount,
      completeSnapshot,
      truncated: listing.truncated,
      ...result,
    };
  }

  return Object.freeze({ scanStorage });
}

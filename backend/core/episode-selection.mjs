import { detectQuality, extractEpisodeNumber } from './media-naming.mjs';

const VIDEO_EXTENSION_RE = /\.(?:mp4|mkv|m4v|avi|mov|ts|m2ts|wmv|flv|webm|mpg|mpeg|rmvb|rm)$/i;

export function selectSharedEpisodeFiles(files, missingEpisodeNumbers, { seasonNumber = 1 } = {}) {
  const season = Number(seasonNumber);
  if (!Number.isSafeInteger(season) || season < 1) {
    throw new TypeError('seasonNumber must be a positive integer');
  }
  const wanted = new Set(
    (missingEpisodeNumbers || [])
      .map(Number)
      .filter((number) => Number.isSafeInteger(number) && number > 0),
  );
  const bestByEpisode = new Map();

  for (const file of files || []) {
    const name = String(file?.name || file?.fileName || '');
    const id = file?.id;
    if (id == null || id === '' || !VIDEO_EXTENSION_RE.test(name)) continue;

    const namedSeason = name.match(/S(\d+)E\d+/i);
    if (namedSeason ? Number(namedSeason[1]) !== season : season !== 1) continue;

    const episodeNumber = extractEpisodeNumber(name);
    if (!episodeNumber || !wanted.has(episodeNumber)) continue;

    const quality = detectQuality(name);
    const rank = QUALITY_RANK[quality] || 0;
    const rawSize = Number(file.size || 0);
    const size = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : 0;
    const prior = bestByEpisode.get(episodeNumber);
    if (!prior || rank > prior.rank || (rank === prior.rank && size > prior.size)) {
      bestByEpisode.set(episodeNumber, {
        id: String(id),
        name,
        seasonNumber: season,
        episodeNumber,
        quality,
        size,
        path: typeof file.path === 'string' ? file.path : null,
        rank,
      });
    }
  }

  return [...bestByEpisode.values()]
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
    .map(({ rank, ...file }) => file);
}

export const QUALITY_RANK = Object.freeze({
  '4K': 4,
  '1080p': 3,
  '720p': 2,
  SD: 1,
});

export function limitEpisodeSaveBatch(selectedFiles, {
  maxEpisodes = 3,
  maxBytes = 8 * 1024 ** 3,
} = {}) {
  if (!Number.isSafeInteger(maxEpisodes) || maxEpisodes < 1
      || !Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new TypeError('invalid episode save batch limits');
  }

  const selected = Array.isArray(selectedFiles) ? selectedFiles : [];
  const files = [];
  let bytes = 0;
  for (const file of selected) {
    const size = Number(file?.size || 0);
    if (!Number.isFinite(size) || size <= 0) continue;
    if (files.length >= maxEpisodes || (files.length > 0 && bytes + size > maxBytes)) break;
    files.push(file);
    bytes += size;
  }
  return {
    files,
    bytes,
    deferred: Math.max(0, selected.length - files.length),
  };
}

export function planResourceEpisodeSelection({
  missingAiredEpisodeNumbers = [],
  missingFutureEpisodeNumbers = [],
  files = [],
  seasonNumber = 1,
} = {}) {
  const futureCandidates = selectSharedEpisodeFiles(
    files,
    missingFutureEpisodeNumbers,
    { seasonNumber },
  );
  const futureAvailableEpisodeNumbers = futureCandidates.map((file) => file.episodeNumber);
  const requestedEpisodeNumbers = [...new Set([
    ...missingAiredEpisodeNumbers.map(Number),
    ...futureAvailableEpisodeNumbers,
  ])]
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .sort((a, b) => a - b);

  return {
    requestedEpisodeNumbers,
    futureAvailableEpisodeNumbers,
    selectedFiles: selectSharedEpisodeFiles(files, requestedEpisodeNumbers, { seasonNumber }),
  };
}

const QUALITY_RE = /\b(2160p|UHD|1080p|FHD|720p|HD|SD|BluRay)\b|\b(4K)(?=\b|HDR|SDR|60FPS)/i;
const QUALITY_NORMALIZE = Object.freeze({
  '2160P': '4K',
  '4K': '4K',
  UHD: '4K',
  '1080P': '1080p',
  FHD: '1080p',
  BLURAY: '1080p',
  '720P': '720p',
  HD: '720p',
  SD: 'SD',
});

const VIDEO_EXTENSION_RE = /\.(?:mp4|mkv|m4v|avi|mov|ts|m2ts|wmv|flv|webm|mpg|mpeg|rmvb|rm)$/i;

export const QUALITY_RANK = Object.freeze({
  '4K': 4,
  '1080p': 3,
  '720p': 2,
  SD: 1,
});

export function detectQuality(fileName) {
  const match = String(fileName || '').match(QUALITY_RE);
  if (!match) return null;
  const key = (match[1] || match[2]).toUpperCase();
  return QUALITY_NORMALIZE[key] || key;
}

export function extractEpisodeNumber(name) {
  const fileName = String(name || '');
  if (!fileName) return null;

  const seasonEpisodeMatch = fileName.match(/S\d+E(\d+)/i);
  if (seasonEpisodeMatch) return Number.parseInt(seasonEpisodeMatch[1], 10);

  const episodeMatch = fileName.match(/E(\d+)/i) || fileName.match(/EP(\d+)/i);
  if (episodeMatch) return Number.parseInt(episodeMatch[1], 10);

  const chineseMatch = fileName.match(/第(\d+)[集期]/);
  if (chineseMatch) return Number.parseInt(chineseMatch[1], 10);

  const leadingNumber = fileName.match(/^\d+[\s.]/)
    || fileName.match(/^\d{1,3}(?:\(\d+\))?[-~]/)
    || fileName.match(/^\d{1,3}\(\d+\)\./)
    || fileName.match(/^\d+$/);
  if (!leadingNumber) return null;
  const number = leadingNumber[0].match(/^\d+/)?.[0];
  return number ? Number.parseInt(number, 10) : null;
}

export function episodeFromVideoFile(file) {
  const name = String(file?.name || file?.fileName || '');
  if (!name || file?.isDir || !VIDEO_EXTENSION_RE.test(name)) return null;
  const episodeNumber = extractEpisodeNumber(name);
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) return null;
  const seasonMatch = name.match(/S(\d+)E\d+/i);
  return {
    seasonNumber: seasonMatch ? Number(seasonMatch[1]) : 1,
    episodeNumber,
    quality: detectQuality(name),
  };
}

export function formatCanonicalEpisodeName({
  showName,
  seasonNumber,
  episodeNumber,
  quality,
  extension,
} = {}) {
  const title = String(showName || '')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  const season = Number(seasonNumber);
  const episode = Number(episodeNumber);
  if (!title) throw new TypeError('showName is required');
  if (!Number.isSafeInteger(season) || season < 1
      || !Number.isSafeInteger(episode) || episode < 1) {
    throw new TypeError('seasonNumber and episodeNumber must be positive integers');
  }
  const ext = String(extension || '').match(/^\.[a-z0-9]{1,8}$/i)?.[0];
  if (!ext || !VIDEO_EXTENSION_RE.test('file' + ext)) {
    throw new TypeError('extension must be a supported video extension');
  }
  const normalizedQuality = QUALITY_NORMALIZE[String(quality || '').toUpperCase()]
    || (quality == null || quality === '' ? null : String(quality));
  const qualitySuffix = normalizedQuality ? ' ' + normalizedQuality : '';
  return title + ' S' + String(season).padStart(2, '0')
    + 'E' + String(episode).padStart(2, '0') + qualitySuffix + ext.toLowerCase();
}

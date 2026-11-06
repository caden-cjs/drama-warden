import { lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { defineResourcePlugin } from '../contract.mjs';

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_CACHE_MS = 60_000;
const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.webm', '.wmv', '.mpg', '.mpeg', '.ogv',
]);

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function positiveLimit(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 20) : 10;
}

function seasonDirectoryScore(suffix) {
  if (/^season\d{1,2}$/.test(suffix)) return 80;
  if (/^s\d{1,2}$/.test(suffix)) return 80;
  if (/^(?:19|20)\d{2}$/.test(suffix)) return 70;
  return 0;
}

function videoEpisodeScore(suffix) {
  if (/^s\d{1,2}e\d{1,3}/.test(suffix)) return 75;
  if (/^(?:episode|ep|e)\d{1,3}/.test(suffix)) return 70;
  if (/^\d{1,3}(?:v\d+)?/.test(suffix)) return 65;
  return 0;
}

function shareUrl(relativePath) {
  const encoded = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return 'local-share:/' + encoded;
}

export function createLocalResourcePlugin({
  shareRoot,
  maxEntries = DEFAULT_MAX_ENTRIES,
  cacheMs = DEFAULT_CACHE_MS,
} = {}) {
  const configuredRoot = path.resolve(String(shareRoot || ''));
  if (!shareRoot) throw new TypeError('shareRoot is required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries must be a positive integer');
  }
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0) {
    throw new TypeError('cacheMs must be a nonnegative integer');
  }

  let shareRootPath = null;
  let indexCache = null;

  async function initialize() {
    shareRootPath = await realpath(configuredRoot);
    if (!(await lstat(shareRootPath)).isDirectory()) {
      shareRootPath = null;
      const error = new Error('shareRoot must be a directory');
      error.code = 'INVALID_SHARE_ROOT';
      throw error;
    }
    indexCache = null;
  }

  function requireReady() {
    if (!shareRootPath) {
      const error = new Error('local resource provider is not initialized');
      error.code = 'PLUGIN_NOT_INITIALIZED';
      throw error;
    }
  }

  async function buildIndex() {
    requireReady();
    const directories = [];
    const files = [];
    let visited = 0;
    let truncated = false;

    async function visit(directory, depth) {
      if (depth > 12) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
        throw error;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (visited >= maxEntries) {
          truncated = true;
          return;
        }
        visited += 1;
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(directory, entry.name);
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink()) continue;
        const relativePath = path.relative(shareRootPath, fullPath).split(path.sep).join('/');
        if (stat.isDirectory()) {
          directories.push(relativePath);
          await visit(fullPath, depth + 1);
        } else if (stat.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(relativePath);
        }
        if (truncated) return;
      }
    }

    await visit(shareRootPath, 0);
    return { directories, files, truncated, indexedAt: Date.now() };
  }

  async function getIndex() {
    if (indexCache && Date.now() - indexCache.indexedAt < cacheMs) return indexCache;
    indexCache = await buildIndex();
    return indexCache;
  }

  async function search({ query, aliases = [], mediaType = 'tv', limit } = {}) {
    requireReady();
    if (mediaType !== 'tv') return { items: [], truncated: false };
    const terms = [...new Set([query, ...(Array.isArray(aliases) ? aliases : [])]
      .map(normalizeTitle)
      .filter((term) => term.length >= 3))];
    if (terms.length === 0) return { items: [], truncated: false };

    const index = await getIndex();
    const matches = new Map();
    for (const relativePath of index.directories) {
      const basename = normalizeTitle(path.posix.basename(relativePath));
      for (const term of terms) {
        const suffix = basename.startsWith(term) ? basename.slice(term.length) : null;
        const score = basename === term ? 100 : suffix == null ? 0 : seasonDirectoryScore(suffix);
        if (score > 0) {
          matches.set(relativePath, { relativePath, score });
          break;
        }
      }
    }
    for (const relativePath of index.files) {
      const basename = normalizeTitle(path.posix.basename(relativePath, path.posix.extname(relativePath)));
      for (const term of terms) {
        const suffix = basename.startsWith(term) ? basename.slice(term.length) : null;
        const score = basename === term ? 90 : suffix == null ? 0 : videoEpisodeScore(suffix);
        if (score > 0) {
          matches.set(relativePath, { relativePath, score });
          break;
        }
      }
    }

    const candidates = [...matches.values()]
      .sort((left, right) => right.score - left.score
        || left.relativePath.localeCompare(right.relativePath))
      .slice(0, positiveLimit(limit))
      .map(({ relativePath }) => ({
        shareUrl: shareUrl(relativePath),
        title: path.posix.basename(relativePath),
        sourceId: relativePath,
      }));
    return { items: candidates, truncated: index.truncated };
  }

  return defineResourcePlugin({
    manifest: {
      id: 'local-resource',
      name: 'Local share search',
      label: '本地分享搜索',
      version: '0.1.0',
      configSchema: {
        version: 1,
        fields: [{ key: 'shareRoot', label: 'Share root', type: 'text', required: true }],
      },
    },
    search,
    initialize,
    reset: async () => { indexCache = null; },
    health: async () => ({ ok: shareRootPath !== null }),
  });
}

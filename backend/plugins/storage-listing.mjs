import path from 'node:path';

const MAX_LISTING_ENTRIES = 10000;
const MAX_LISTING_DEPTH = 20;

function safeName(value) {
  const name = String(value || '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    const error = new Error('storage provider returned an unsafe item name');
    error.code = 'INVALID_STORAGE_LISTING';
    throw error;
  }
  return name;
}

export async function listStorageTree(rootPath, options = {}, listDirectory) {
  if (typeof listDirectory !== 'function') throw new TypeError('listDirectory must be a function');
  const rawRoot = String(rootPath || '/');
  const root = path.posix.normalize(rawRoot);
  if (!root.startsWith('/') || rawRoot.includes('\0') || rawRoot.includes('\\')
      || rawRoot.split('/').some((part) => part === '.' || part === '..')) {
    const error = new Error('storage path must be absolute');
    error.code = 'INVALID_STORAGE_PATH';
    throw error;
  }
  const recursive = options.recursive === true;
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? Math.min(options.maxEntries, MAX_LISTING_ENTRIES)
    : MAX_LISTING_ENTRIES;
  const maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth > 0
    ? Math.min(options.maxDepth, MAX_LISTING_DEPTH)
    : MAX_LISTING_DEPTH;
  const pending = [{ path: root, depth: 0 }];
  const visited = new Set([root]);
  const files = [];
  let truncated = false;
  let recent = false;

  while (pending.length) {
    const current = pending.shift();
    const listing = await listDirectory(current.path);
    if (!listing || !Array.isArray(listing.files)) {
      const error = new Error('storage provider returned an invalid directory listing');
      error.code = 'INVALID_STORAGE_LISTING';
      throw error;
    }
    if (listing.truncated === true) truncated = true;
    if (current.depth === 0) recent = Boolean(listing.recent);
    for (const item of listing.files) {
      if (files.length >= maxEntries) {
        truncated = true;
        break;
      }
      const name = safeName(item?.name ?? item?.fileName);
      const itemPath = path.posix.join(current.path, name);
      const isDir = Boolean(item?.isDir ?? item?.is_dir ?? item?.dir);
      files.push({
        ...item,
        name,
        path: itemPath,
        isDir,
        size: Number(item?.size || 0),
        mtime: Number(item?.mtime || 0),
      });
      if (!recursive || !isDir) continue;
      if (current.depth >= maxDepth) {
        truncated = true;
        continue;
      }
      if (!visited.has(itemPath)) {
        visited.add(itemPath);
        pending.push({ path: itemPath, depth: current.depth + 1 });
      }
    }
    if (files.length >= maxEntries) truncated = true;
  }

  return { path: root, files, total: files.length, truncated, recent };
}

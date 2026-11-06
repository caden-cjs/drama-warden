import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { defineStoragePlugin } from '../contract.mjs';

const DEFAULT_MAX_ENTRIES = 10000;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const SIDECAR_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt']);

function pluginError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredText(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(field + ' is required');
  return result;
}

function pathSegments(value, field, { allowRoot = false } = {}) {
  const text = String(value ?? '').trim();
  if (text.includes('\0') || text.includes('\\')) {
    throw pluginError(field + ' contains an invalid path character', 'INVALID_STORAGE_PATH');
  }
  const segments = text.split('/').filter(Boolean);
  if ((!allowRoot && segments.length === 0)
      || segments.some((segment) => segment === '.' || segment === '..')) {
    throw pluginError(field + ' is not a safe path', 'INVALID_STORAGE_PATH');
  }
  return segments;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

function mtimeValue(stat) {
  const value = Math.trunc(stat.mtimeMs);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fileId(relativePath) {
  return createHash('sha256').update(relativePath).digest('base64url');
}

function formatVirtualPath(segments) {
  return '/' + segments.join('/');
}

function boundedLimit(value, maxEntries) {
  const requested = Number(value);
  if (!Number.isSafeInteger(requested) || requested <= 0) return maxEntries;
  return Math.min(requested, maxEntries);
}

async function assertNoSymlinkSegments(root, target, { allowMissing = false } = {}) {
  if (!isWithin(root, target)) {
    throw pluginError('path escapes its configured root', 'PATH_OUTSIDE_ROOT');
  }
  const relative = path.relative(root, target);
  if (!relative) return;

  let current = root;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw pluginError('symbolic links are not supported', 'UNSAFE_SYMLINK');
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw pluginError('a path parent is not a directory', 'INVALID_STORAGE_PATH');
    }
  }
}

export function createLocalStoragePlugin({
  storageRoot,
  shareRoot,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const configuredStorageRoot = path.resolve(requiredText(storageRoot, 'storageRoot'));
  const configuredShareRoot = path.resolve(requiredText(shareRoot, 'shareRoot'));
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('maxEntries must be a positive integer');
  }

  let storageRootPath = null;
  let shareRootPath = null;

  async function initialize() {
    await mkdir(configuredStorageRoot, { recursive: true });
    storageRootPath = await realpath(configuredStorageRoot);
    shareRootPath = await realpath(configuredShareRoot);
    const rootsOverlap = isWithin(storageRootPath, shareRootPath)
      || isWithin(shareRootPath, storageRootPath);
    if (rootsOverlap) {
      storageRootPath = null;
      shareRootPath = null;
      throw pluginError(
        'storageRoot and shareRoot must be separate directories',
        'LOCAL_ROOTS_OVERLAP',
      );
    }
    const shareStat = await lstat(shareRootPath);
    if (!shareStat.isDirectory()) {
      storageRootPath = null;
      shareRootPath = null;
      throw pluginError('shareRoot must be a directory', 'INVALID_SHARE_ROOT');
    }
  }

  function requireReady() {
    if (!storageRootPath || !shareRootPath) {
      throw pluginError('local storage plugin is not initialized', 'PLUGIN_NOT_INITIALIZED');
    }
  }

  async function resolveStoragePath(value, { allowRoot = true, allowMissing = false } = {}) {
    requireReady();
    const segments = pathSegments(value, 'storage path', { allowRoot });
    const target = path.resolve(storageRootPath, ...segments);
    if (!isWithin(storageRootPath, target)) {
      throw pluginError('storage path escapes its configured root', 'PATH_OUTSIDE_ROOT');
    }
    await assertNoSymlinkSegments(storageRootPath, target, { allowMissing });
    return { target, segments };
  }

  async function resolveShareUrl(value) {
    requireReady();
    const rawUrl = requiredText(value, 'shareUrl');
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw pluginError('shareUrl must use the local-share scheme', 'INVALID_SHARE_URL');
    }
    if (url.protocol !== 'local-share:' || !url.pathname.startsWith('/')
        || url.host || url.username || url.password
        || url.search || url.hash) {
      throw pluginError('shareUrl must use a local-share path without query or fragment', 'INVALID_SHARE_URL');
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      throw pluginError('shareUrl contains invalid path encoding', 'INVALID_SHARE_URL');
    }
    const segments = pathSegments(decodedPath, 'share path', { allowRoot: true });
    const target = path.resolve(shareRootPath, ...segments);
    if (!isWithin(shareRootPath, target)) {
      throw pluginError('share path escapes its configured root', 'PATH_OUTSIDE_ROOT');
    }
    await assertNoSymlinkSegments(shareRootPath, target);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw pluginError('share path must be a regular file or directory', 'INVALID_SHARE_PATH');
    }
    return { target, isDirectory: stat.isDirectory() };
  }

  async function storageListing(input = {}) {
    const { target, segments } = await resolveStoragePath(input.path, { allowRoot: true });
    const rootStat = await lstat(target);
    if (!rootStat.isDirectory()) {
      throw pluginError('storage listing path must be a directory', 'NOT_A_DIRECTORY');
    }
    const recursive = input.options?.recursive === true;
    const limit = boundedLimit(input.options?.limit, maxEntries);
    const files = [];
    let total = 0;
    let truncated = false;

    async function visit(directory, relativeSegments) {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (truncated) return;
        const fullPath = path.join(directory, entry.name);
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink()) {
          throw pluginError('symbolic links are not supported', 'UNSAFE_SYMLINK');
        }
        if (!stat.isDirectory() && !stat.isFile()) continue;
        total += 1;
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        const itemSegments = [...relativeSegments, entry.name];
        files.push({
          name: entry.name,
          path: formatVirtualPath([...segments, ...itemSegments]),
          isDir: stat.isDirectory(),
          size: stat.isFile() ? stat.size : 0,
          mtime: mtimeValue(stat),
        });
        if (recursive && stat.isDirectory()) await visit(fullPath, itemSegments);
      }
    }

    await visit(target, []);
    return {
      path: formatVirtualPath(segments),
      files,
      total,
      truncated,
      recent: [],
    };
  }

  async function sharedListing(input = {}) {
    const share = await resolveShareUrl(input.shareUrl);
    const limit = boundedLimit(input.options?.limit, maxEntries);
    const files = [];
    let total = 0;
    let visitedEntries = 0;
    let truncated = false;

    async function visit(currentPath) {
      if (truncated) return;
      const currentStat = await lstat(currentPath);
      if (currentStat.isFile()) {
        visitedEntries += 1;
        total += 1;
        if (files.length >= limit || visitedEntries > maxEntries) {
          truncated = true;
          return;
        }
        const rootRelative = path.relative(shareRootPath, currentPath).split(path.sep).join('/');
        const shareRelative = share.isDirectory
          ? path.relative(share.target, currentPath).split(path.sep).join('/')
          : path.basename(currentPath);
        files.push({
          id: fileId(rootRelative),
          name: path.basename(currentPath),
          path: shareRelative,
          isDir: false,
          size: currentStat.size,
          mtime: mtimeValue(currentStat),
        });
        return;
      }

      const entries = await readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (truncated) return;
        visitedEntries += 1;
        if (visitedEntries > maxEntries) {
          truncated = true;
          return;
        }
        const fullPath = path.join(currentPath, entry.name);
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink()) {
          throw pluginError('symbolic links are not supported', 'UNSAFE_SYMLINK');
        }
        if (stat.isDirectory()) {
          await visit(fullPath);
        } else if (stat.isFile()) {
          total += 1;
          if (files.length >= limit) {
            truncated = true;
            return;
          }
          const rootRelative = path.relative(shareRootPath, fullPath).split(path.sep).join('/');
          const shareRelative = share.isDirectory
            ? path.relative(share.target, fullPath).split(path.sep).join('/')
            : path.basename(fullPath);
          files.push({
            id: fileId(rootRelative),
            name: entry.name,
            path: shareRelative,
            isDir: false,
            size: stat.size,
            mtime: mtimeValue(stat),
          });
        }
      }
    }

    await visit(share.target);
    return { files, total, truncated };
  }

  async function removePath(value, mode) {
    if (mode !== 'permanent') {
      throw pluginError('local storage only supports permanent removal', 'UNSUPPORTED_REMOVE_MODE');
    }
    const { target } = await resolveStoragePath(value, { allowRoot: false });
    const stat = await lstat(target);
    if (stat.isDirectory()) await rm(target, { recursive: true });
    else if (stat.isFile()) await unlink(target);
    else throw pluginError('only files and directories can be removed', 'INVALID_STORAGE_PATH');
    return { ok: true, mode: 'permanent', path: value };
  }

  async function renameItems(items = []) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new TypeError('items must be a non-empty array');
    }
    const planned = [];
    const sources = new Set();
    const targets = new Set();
    for (const item of items) {
      const { target: source } = await resolveStoragePath(item?.path, { allowRoot: false });
      if (sources.has(source)) {
        throw pluginError('rename sources must be unique', 'INVALID_RENAME_ITEMS');
      }
      sources.add(source);
      const name = requiredText(item?.newName, 'newName');
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw pluginError('newName must be a single path segment', 'INVALID_STORAGE_PATH');
      }
      const destination = path.join(path.dirname(source), name);
      if (!isWithin(storageRootPath, destination)) {
        throw pluginError('rename destination escapes its configured root', 'PATH_OUTSIDE_ROOT');
      }
      await assertNoSymlinkSegments(storageRootPath, destination, { allowMissing: true });
      const key = path.resolve(destination);
      if (targets.has(key)) throw pluginError('rename targets must be unique', 'DESTINATION_CONFLICT');
      targets.add(key);
      planned.push({ source, destination });
    }

    for (const item of planned) {
      if (item.source === item.destination) continue;
      try {
        await lstat(item.destination);
        throw pluginError('rename target already exists', 'DESTINATION_CONFLICT');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    let renamedCount = 0;
    for (const item of planned) {
      if (item.source === item.destination) continue;
      await rename(item.source, item.destination);
      renamedCount += 1;
    }
    return { ok: true, renamedCount };
  }

  async function save(input = {}) {
    const share = await sharedListing({ shareUrl: input.shareUrl });
    if (share.truncated) {
      throw pluginError('share listing is incomplete', 'INCOMPLETE_LISTING');
    }
    if (!Array.isArray(input.selection) || input.selection.length === 0) {
      throw pluginError('local storage requires an explicit file selection', 'SELECTION_REQUIRED');
    }
    const selectedIds = new Set();
    const selected = input.selection.map((item) => {
      const id = requiredText(item?.id, 'selection.id');
      if (selectedIds.has(id)) throw pluginError('selection contains duplicate file ids', 'INVALID_SELECTION');
      selectedIds.add(id);
      const matches = share.files.filter((file) => file.id === id
        && file.name === item.name
        && file.path === item.path
        && file.size === Number(item.size));
      if (matches.length !== 1) {
        throw pluginError('selected share file changed or is ambiguous', 'SHARE_SELECTION_CHANGED');
      }
      return matches[0];
    });

    const shareRoot = await resolveShareUrl(input.shareUrl);
    const destination = await resolveStoragePath(input.destinationPath, { allowRoot: false });
    const destinationStat = await lstat(destination.target);
    if (!destinationStat.isDirectory()) {
      throw pluginError('save destination must be a directory', 'NOT_A_DIRECTORY');
    }

    let savedCount = 0;
    for (const item of selected) {
      const sourceParts = shareRoot.isDirectory
        ? pathSegments(item.path, 'selected share path')
        : [path.basename(shareRoot.target)];
      const source = shareRoot.isDirectory
        ? path.resolve(shareRoot.target, ...sourceParts)
        : shareRoot.target;
      if (!isWithin(shareRoot.target, source)) {
        throw pluginError('selected share path escapes the share root', 'PATH_OUTSIDE_ROOT');
      }
      await assertNoSymlinkSegments(shareRoot.target, source);
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.size !== item.size) {
        throw pluginError('selected share file changed before save', 'SHARE_SELECTION_CHANGED');
      }
      const target = path.join(destination.target, item.name);
      await assertNoSymlinkSegments(storageRootPath, target, { allowMissing: true });
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      const savedStat = await lstat(target);
      if (!savedStat.isFile() || savedStat.size !== item.size) {
        throw pluginError('saved file size did not match the selected source', 'SAVE_VERIFICATION_FAILED');
      }
      savedCount += 1;
    }
    return { ok: true, savedCount };
  }

  async function writeSidecar(input = {}) {
    const videoPath = requiredText(input.videoPath, 'videoPath');
    const name = requiredText(input.fileName, 'fileName');
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (name.length > 255 || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
        || /[\u0000-\u001f\u007f]/.test(name) || !SIDECAR_EXTENSIONS.has(extension)) {
      throw pluginError('subtitle file name is invalid', 'INVALID_SIDECAR_NAME');
    }
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : input.content instanceof Uint8Array ? Buffer.from(input.content) : null;
    if (!content || content.length === 0 || content.length > MAX_SIDECAR_BYTES) {
      throw pluginError('subtitle content is invalid or too large', 'INVALID_SIDECAR_CONTENT');
    }

    const video = await resolveStoragePath(videoPath, { allowRoot: false });
    const videoStat = await lstat(video.target);
    if (!videoStat.isFile()) throw pluginError('videoPath must refer to a file', 'INVALID_VIDEO_PATH');
    const parentSegments = pathSegments(path.posix.dirname(videoPath), 'video parent path', { allowRoot: true });
    const targetPath = formatVirtualPath([...parentSegments, name]);
    const target = await resolveStoragePath(targetPath, { allowRoot: false, allowMissing: true });
    try {
      await lstat(target.target);
      throw pluginError('subtitle target already exists', 'DESTINATION_CONFLICT');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await writeFile(target.target, content, { flag: 'wx', mode: 0o644 });
    const savedStat = await lstat(target.target);
    if (!savedStat.isFile() || savedStat.size !== content.length) {
      throw pluginError('subtitle write could not be verified', 'SIDECAR_WRITE_UNCONFIRMED');
    }
    return { ok: true, path: targetPath, size: content.length };
  }

  async function cleanStorage(input = {}) {
    if (input.mode !== 'permanent') {
      throw pluginError('local storage only supports permanent removal', 'UNSUPPORTED_REMOVE_MODE');
    }
    const { target } = await resolveStoragePath(input.path, { allowRoot: false });
    const stat = await lstat(target);
    if (!stat.isDirectory()) throw pluginError('clean path must be a directory', 'NOT_A_DIRECTORY');
    const options = input.options || {};
    const keepFiles = Array.isArray(options.keepFiles)
      ? options.keepFiles.map((value) => String(value))
      : [];
    const deleteSubdirs = options.deleteSubdirs === true;
    const deleteFiles = options.deleteDuplicates === true && keepFiles.length > 0;
    const kept = [];
    const keptDirs = [];
    const deleted = [];
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(target, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw pluginError('symbolic links are not supported', 'UNSAFE_SYMLINK');
      }
      if (entryStat.isDirectory()) {
        if (deleteSubdirs) {
          await rm(entryPath, { recursive: true });
          deleted.push({ name: entry.name, type: 'directory' });
        } else {
          keptDirs.push(entry.name);
        }
      } else if (entryStat.isFile()) {
        const keep = keepFiles.some((keyword) => entry.name.includes(keyword));
        if (deleteFiles && !keep) {
          await unlink(entryPath);
          deleted.push({ name: entry.name, type: 'file' });
        } else {
          kept.push(entry.name);
        }
      }
    }
    return { ok: true, mode: 'permanent', path: input.path, kept, keptDirs, deleted };
  }

  return defineStoragePlugin({
    manifest: {
      id: 'local-storage',
      name: 'Local filesystem',
      label: '本地文件系统',
      version: '0.1.0',
      configSchema: {
        version: 1,
        fields: [
          { key: 'storageRoot', label: 'Storage root', type: 'text', required: true },
          { key: 'shareRoot', label: 'Share root', type: 'text', required: true },
        ],
      },
    },
    actions: {
      async list(input) {
        return storageListing(input);
      },
      async listSharedFiles(input) {
        return sharedListing(input);
      },
      async save(input) {
        return save(input);
      },
      async writeSidecar(input) {
        return writeSidecar(input);
      },
      async move(input = {}) {
        const source = await resolveStoragePath(input.sourcePath, { allowRoot: false });
        const destination = await resolveStoragePath(input.destinationPath, {
          allowRoot: false,
          allowMissing: true,
        });
        await assertNoSymlinkSegments(storageRootPath, path.dirname(destination.target));
        try {
          await lstat(destination.target);
          throw pluginError('move target already exists', 'DESTINATION_CONFLICT');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await rename(source.target, destination.target);
        return { ok: true, sourcePath: input.sourcePath, destinationPath: input.destinationPath };
      },
      async mkdir(input = {}) {
        const { target } = await resolveStoragePath(input.path, {
          allowRoot: true,
          allowMissing: true,
        });
        await mkdir(target, { recursive: true });
        await assertNoSymlinkSegments(storageRootPath, target);
        return { ok: true, path: input.path };
      },
      async rename(input = {}) {
        return renameItems([{ path: input.path, newName: input.newName }]);
      },
      async renameMany(input = {}) {
        return renameItems(input.items);
      },
      async remove(input = {}) {
        return removePath(input.path, input.mode);
      },
      async clean(input = {}) {
        return cleanStorage(input);
      },
      async status() {
        return {
          ok: Boolean(storageRootPath && shareRootPath),
          configured: Boolean(storageRootPath && shareRootPath),
          provider: 'local-storage',
        };
      },
    },
    removeModes: ['permanent'],
    initialize,
    async health() {
      try {
        requireReady();
        await access(storageRootPath);
        await access(shareRootPath);
        return { ok: true, configured: true };
      } catch (error) {
        return { ok: false, configured: false, errorCode: error?.code || 'LOCAL_STORAGE_ERROR' };
      }
    },
  });
}

import path from 'node:path';
import { defineStoragePlugin } from '../contract.mjs';
import { listStorageTree } from '../storage-listing.mjs';
import { publicShareFile, resolveShareSelection } from '../share-reference.mjs';
import * as api from './cli.mjs';

const REMOVE_MODE = 'permanent';

function pluginError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloudPath(value, field) {
  const input = String(value ?? '').trim();
  if (!input || !input.startsWith('/') || input.includes('\0') || input.includes('\\')
      || input.split('/').some((part) => part === '.' || part === '..')) {
    throw pluginError(field + ' must be an absolute safe path', 'INVALID_STORAGE_PATH');
  }
  return path.posix.normalize(input);
}

function normalizeSharedFile(file) {
  const providerId = String(file?.id ?? file?.fid ?? '');
  const name = String(file?.name ?? file?.filename ?? '');
  if (!providerId || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw pluginError('115 share listing returned an unsafe item', 'INVALID_SHARED_FILE');
  }
  const directory = String(file?.path || '').replace(/^\/+|\/+$/g, '');
  if (directory.split('/').some((part) => part === '.' || part === '..')) {
    throw pluginError('115 share listing returned an unsafe relative path', 'INVALID_SHARED_FILE');
  }
  const relativePath = directory === name || directory.endsWith('/' + name)
    ? directory
    : directory ? path.posix.join(directory, name) : name;
  return {
    providerId,
    name,
    path: relativePath,
    isDir: false,
    size: Number(file?.size || 0),
    mtime: Number(file?.mtime || 0),
  };
}

function normalizeDirectoryListing(result) {
  return {
    files: (result?.files || []).map((file) => ({
      name: String(file?.name ?? file?.fileName ?? ''),
      isDir: Boolean(file?.isDir ?? file?.is_dir ?? file?.dir),
      size: Number(file?.size || 0),
      mtime: Number(file?.mtime || 0),
    })),
    truncated: Boolean(result?.truncated),
    recent: Boolean(result?.recent),
  };
}

function statusShape(status) {
  return {
    ok: Boolean(status?.ok),
    configured: Boolean(status?.configured),
    provider: 'pan115',
    ...(status?.username ? { username: String(status.username).slice(0, 100) } : {}),
    ...(status?.vip != null ? { vip: status.vip } : {}),
    ...(status?.expiresAt ? { expiresAt: status.expiresAt } : {}),
  };
}

export function createPan115StoragePlugin({
  adapter = api,
  cookie = process.env.PAN115_COOKIE || '',
} = {}) {
  let initializationError = false;
  let authorization = null;

  async function ensureCookieImported() {
    const value = String(cookie || '').trim();
    if (!value) return;
    if (!authorization) {
      authorization = adapter.pan115Authorize(value).catch(() => {
        initializationError = true;
        throw pluginError('115 Cookie import or account validation failed', 'PAN115_AUTH_FAILED');
      });
    }
    await authorization;
  }

  async function listDirectory(targetPath) {
    await ensureCookieImported();
    return normalizeDirectoryListing(await adapter.pan115List(targetPath, { limit: 500 }));
  }

  async function listSharedFiles({ shareUrl, options = {} } = {}) {
    await ensureCookieImported();
    if (!shareUrl) throw new TypeError('shareUrl is required');
    const providerFiles = (await adapter.pan115ShareFiles(shareUrl, options)).map(normalizeSharedFile);
    return {
      files: providerFiles.map((file) => publicShareFile(shareUrl, file)),
      total: providerFiles.length,
      truncated: false,
    };
  }

  async function save({ shareUrl, destinationPath, selection } = {}) {
    await ensureCookieImported();
    if (!shareUrl) throw new TypeError('shareUrl is required');
    const destination = cloudPath(destinationPath, 'destinationPath');
    const currentFiles = (await adapter.pan115ShareFiles(shareUrl)).map(normalizeSharedFile);
    const selectedFiles = resolveShareSelection(shareUrl, selection, currentFiles);
    const result = await adapter.pan115Save(shareUrl, destination, {
      selection: selectedFiles.map((file) => ({
        id: file.providerId,
        path: file.path,
        name: file.name,
      })),
    });
    return {
      ok: Boolean(result?.ok),
      savedCount: result?.savedCount ?? selectedFiles.length,
      completed: true,
      verified: null,
      status: null,
    };
  }

  async function move({ sourcePath, destinationPath } = {}) {
    await ensureCookieImported();
    const source = cloudPath(sourcePath, 'sourcePath');
    const destination = cloudPath(destinationPath, 'destinationPath');
    await adapter.pan115Move(source, destination);
    return { ok: true, sourcePath: source, destinationPath: destination };
  }

  async function renameMany({ items = [] } = {}) {
    await ensureCookieImported();
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    const normalized = items.map((item) => {
      const source = cloudPath(item?.path, 'items.path');
      const name = String(item?.newName || '');
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw pluginError('newName must be a basename', 'INVALID_STORAGE_PATH');
      }
      return { path: source, newName: name };
    });
    let renamedCount = 0;
    for (const item of normalized) {
      await adapter.pan115Move(item.path, path.posix.join(path.posix.dirname(item.path), item.newName));
      renamedCount += 1;
    }
    return { ok: true, renamedCount };
  }

  async function requireRemoveMode(mode) {
    if (mode !== REMOVE_MODE) {
      throw pluginError('115 supports remove mode "permanent" only', 'UNSUPPORTED_REMOVE_MODE');
    }
  }

  return defineStoragePlugin({
    manifest: {
      id: 'pan115',
      name: '115 Cloud Drive',
      label: '115 网盘',
      version: '0.1.0',
      configSchema: {
        version: 1,
        fields: [
          { key: 'cliPath', label: '115cli 路径', type: 'text', required: true },
          { key: 'cookie', label: '115 登录 Cookie', type: 'password' },
        ],
      },
    },
    actions: {
      list: ({ path: targetPath = '/', options = {} } = {}) => listStorageTree(
        cloudPath(targetPath, 'path'), options, listDirectory,
      ),
      listSharedFiles,
      save,
      move,
      mkdir: async ({ path: targetPath } = {}) => {
        await ensureCookieImported();
        const safePath = cloudPath(targetPath, 'path');
        await adapter.mkdirParents(safePath);
        return { ok: true, path: safePath };
      },
      rename: ({ path: sourcePath, newName } = {}) => renameMany({ items: [{ path: sourcePath, newName }] }),
      renameMany,
      remove: async ({ path: targetPath, mode, options = {} } = {}) => {
        await requireRemoveMode(mode);
        await ensureCookieImported();
        const safePath = cloudPath(targetPath, 'path');
        if (safePath === '/') {
          throw pluginError('115 remove cannot target the storage root', 'INVALID_STORAGE_PATH');
        }
        await adapter.pan115Delete(safePath, options);
        return { ok: true, mode: REMOVE_MODE, path: safePath };
      },
      clean: async ({ path: targetPath, mode, options = {} } = {}) => {
        await requireRemoveMode(mode);
        await ensureCookieImported();
        const safePath = cloudPath(targetPath, 'path');
        if (safePath === '/') {
          throw pluginError('115 clean cannot target the storage root', 'INVALID_STORAGE_PATH');
        }
        const listing = await listStorageTree(safePath, {}, listDirectory);
        if (listing.truncated || listing.recent) {
          throw pluginError('115 clean refused an incomplete directory listing', 'INCOMPLETE_STORAGE_LISTING');
        }
        const keepFiles = Array.isArray(options.keepFiles) ? options.keepFiles.map(String) : [];
        const deleteSubdirs = options.deleteSubdirs === true;
        const deleteDuplicates = options.deleteDuplicates === true && keepFiles.length > 0;
        const kept = [];
        const keptDirs = [];
        const deleted = [];
        for (const item of listing.files) {
          if (item.isDir) {
            if (!deleteSubdirs) {
              keptDirs.push(item.name);
              continue;
            }
            await adapter.pan115Delete(item.path, { recursive: true });
            deleted.push({ name: item.name, type: 'dir' });
            continue;
          }
          if (!deleteDuplicates || keepFiles.some((keyword) => item.name.includes(keyword))) {
            kept.push(item.name);
            continue;
          }
          await adapter.pan115Delete(item.path);
          deleted.push({ name: item.name, type: 'file' });
        }
        return { ok: true, mode: REMOVE_MODE, path: safePath, kept, keptDirs, deleted };
      },
      status: async () => {
        await ensureCookieImported();
        return statusShape(await adapter.pan115Status());
      },
    },
    removeModes: [REMOVE_MODE],
    async reset() {
      authorization = null;
      initializationError = false;
    },
    async health() {
      try {
        if (!(await adapter.isAvailable())) {
          return { ok: false, configured: false, detail: '115cli 未安装' };
        }
        await ensureCookieImported();
        const status = statusShape(await adapter.pan115Status());
        return {
          ok: status.ok,
          configured: status.configured,
          detail: status.ok
            ? '115 授权有效'
            : initializationError ? '115 Cookie 导入或账号验证失败' : '115 尚未授权',
        };
      } catch {
        return { ok: false, configured: false, detail: '115cli 不可用' };
      }
    },
  });
}

const plugin = createPan115StoragePlugin();
export const manifest = plugin.manifest;
export const provider = plugin;
export default plugin;

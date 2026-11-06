import path from 'node:path';
import { defineStoragePlugin } from '../contract.mjs';
import { listStorageTree } from '../storage-listing.mjs';
import { publicShareFile, resolveShareSelection } from '../share-reference.mjs';
import * as api from './cli.mjs';

const REMOVE_MODE = 'recycle';

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
  const providerId = String(file?.fid ?? file?.id ?? '');
  const name = String(file?.name ?? file?.filename ?? '');
  if (!providerId || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw pluginError('Quark share listing returned an unsafe item', 'INVALID_SHARED_FILE');
  }
  const directory = String(file?.path || '').replace(/^\/+|\/+$/g, '');
  if (directory.split('/').some((part) => part === '.' || part === '..')) {
    throw pluginError('Quark share listing returned an unsafe relative path', 'INVALID_SHARED_FILE');
  }
  return {
    providerId,
    name,
    path: directory ? path.posix.join(directory, name) : name,
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
      ...(Number(file?.video_width) > 0 ? { videoWidth: Number(file.video_width) } : {}),
      ...(Number(file?.video_height) > 0 ? { videoHeight: Number(file.video_height) } : {}),
    })),
    truncated: Boolean(result?.truncated),
    recent: Boolean(result?.recent),
  };
}

function statusShape(status) {
  return {
    ok: Boolean(status?.ok && status?.valid),
    configured: Boolean(status?.configured),
    authorized: Boolean(status?.valid),
    provider: 'quark',
    ...(status?.username ? { username: String(status.username).slice(0, 100) } : {}),
    ...(status?.expiresAt ? { expiresAt: status.expiresAt } : {}),
    ...(status?.vip != null ? { vip: status.vip } : {}),
  };
}

export function createQuarkStoragePlugin(cli = api) {
  async function listDirectory(targetPath) {
    return normalizeDirectoryListing(await cli.quarkList(targetPath, { limit: 0 }));
  }

  async function listSharedFiles({ shareUrl, options = {} } = {}) {
    if (!shareUrl) throw new TypeError('shareUrl is required');
    const providerFiles = (await cli.quarkShareFiles(shareUrl, options)).map(normalizeSharedFile);
    return {
      files: providerFiles.map((file) => publicShareFile(shareUrl, file)),
      total: providerFiles.length,
      truncated: false,
    };
  }

  async function save({ shareUrl, destinationPath, selection } = {}) {
    if (!shareUrl) throw new TypeError('shareUrl is required');
    const destination = cloudPath(destinationPath, 'destinationPath');
    const currentFiles = (await cli.quarkShareFiles(shareUrl)).map(normalizeSharedFile);
    const selectedFiles = resolveShareSelection(shareUrl, selection, currentFiles);
    const result = await cli.quarkSave(shareUrl, destination, {
      fidList: selectedFiles.map((file) => file.providerId),
    });
    return {
      ok: Boolean(result?.ok),
      savedCount: result?.savedCount ?? selectedFiles.length,
      completed: Boolean(result?.taskPoll?.completed),
      verified: typeof result?.verified === 'boolean' ? result.verified : null,
      status: result?.taskPoll?.status ?? null,
    };
  }

  async function move({ sourcePath, destinationPath } = {}) {
    const source = cloudPath(sourcePath, 'sourcePath');
    const destination = cloudPath(destinationPath, 'destinationPath');
    let destinationIsDirectory = false;
    try {
      await cli.quarkDirectoryFid(destination);
      destinationIsDirectory = true;
    } catch (error) {
      if (!String(error?.message || error).includes('Quark directory not found:')) throw error;
    }
    if (destinationIsDirectory) {
      await cli.quarkMove(source, destination);
      return { ok: true, sourcePath: source, destinationPath: destination };
    }

    const destinationName = path.posix.basename(destination);
    const destinationDirectory = path.posix.dirname(destination);
    const sourceName = path.posix.basename(source);
    if (!destinationName || destinationName === '.' || !sourceName || sourceName === '.') {
      throw pluginError('move requires a file path and a full destination path', 'INVALID_STORAGE_PATH');
    }
    if (sourceName === destinationName) {
      await cli.quarkMove(source, destination);
      return { ok: true, sourcePath: source, destinationPath: destination };
    }
    const before = await cli.quarkList(destinationDirectory, { limit: 0 });
    if ((before.files || []).some((file) => file.name === destinationName)) {
      throw pluginError('move target already exists', 'DESTINATION_CONFLICT');
    }
    await cli.quarkMove(source, destinationDirectory);
    const after = await cli.quarkList(destinationDirectory, { limit: 0 });
    const item = (after.files || []).find((file) => file.name === sourceName);
    if (!item?.fid) throw pluginError('moved Quark item could not be resolved for rename', 'MOVE_UNCONFIRMED');
    const renameResult = await cli.quarkRenameFids([
      { fid: item.fid, oldName: item.name, newName: destinationName },
    ]);
    if (renameResult?.ok !== true) throw pluginError('Quark move rename was not confirmed', 'MOVE_UNCONFIRMED');
    return { ok: true, sourcePath: source, destinationPath: destination };
  }

  async function rename({ path: sourcePath, newName } = {}) {
    return renameMany({ items: [{ path: sourcePath, newName }] });
  }

  async function renameMany({ items = [] } = {}) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    const normalized = items.map((item) => {
      const source = cloudPath(item?.path, 'items.path');
      const name = String(item?.newName || '');
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw pluginError('newName must be a basename', 'INVALID_STORAGE_PATH');
      }
      return { path: source, newName: name };
    });
    const result = await cli.quarkRenameBatch(normalized);
    if (!result || result.ok !== true) throw pluginError('Quark rename batch was not confirmed', 'RENAME_UNCONFIRMED');
    return { ok: true, renamedCount: result.requested ?? normalized.length };
  }

  function requireRemoveMode(mode) {
    if (mode !== REMOVE_MODE) {
      throw pluginError('Quark supports remove mode "recycle" only', 'UNSUPPORTED_REMOVE_MODE');
    }
  }

  async function clean({ path: targetPath, mode, options = {} } = {}) {
    requireRemoveMode(mode);
    const safePath = cloudPath(targetPath, 'path');
    if (safePath === '/') {
      throw pluginError('Quark clean cannot target the storage root', 'INVALID_STORAGE_PATH');
    }
    const listing = await listStorageTree(safePath, {}, listDirectory);
    if (listing.truncated || listing.recent) {
      throw pluginError('Quark clean refused an incomplete directory listing', 'INCOMPLETE_STORAGE_LISTING');
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
        await cli.quarkDelete(item.path);
        deleted.push({ name: item.name, type: 'dir' });
        continue;
      }
      if (!deleteDuplicates || keepFiles.some((keyword) => item.name.includes(keyword))) {
        kept.push(item.name);
        continue;
      }
      await cli.quarkDelete(item.path);
      deleted.push({ name: item.name, type: 'file' });
    }
    return { ok: true, mode: REMOVE_MODE, path: safePath, kept, keptDirs, deleted };
  }

  return defineStoragePlugin({
    manifest: {
      id: 'quark',
      name: 'Quark Cloud Drive',
      label: '夸克网盘',
      version: '0.1.0',
      configSchema: {
        version: 1,
        fields: [{ key: 'cliPath', label: '官方 CLI 路径', type: 'text', required: true }],
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
        const safePath = cloudPath(targetPath, 'path');
        await cli.mkdirChain(safePath);
        return { ok: true, path: safePath };
      },
      rename,
      renameMany,
      remove: ({ path: targetPath, mode } = {}) => {
        requireRemoveMode(mode);
        return cli.quarkDelete(cloudPath(targetPath, 'path'));
      },
      clean,
      status: async () => statusShape(await cli.quarkStatus()),
    },
    removeModes: [REMOVE_MODE],
    async reset() {
      cli.resetAuthStatus?.();
      cli.resetBackendKind?.();
    },
    async health() {
      try {
        const status = statusShape(await cli.quarkStatus());
        return {
          ok: status.ok,
          configured: status.configured,
          authorized: status.authorized,
          detail: status.ok ? '夸克授权有效' : status.configured ? '夸克尚未授权或授权已失效' : '夸克 CLI 未配置',
        };
      } catch {
        return { ok: false, configured: false, detail: '夸克 CLI 不可用' };
      }
    },
  });
}

const plugin = createQuarkStoragePlugin();
export const manifest = plugin.manifest;
export const provider = plugin;
export default plugin;

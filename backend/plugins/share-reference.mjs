import { createHash } from 'node:crypto';

function shareFileId(shareUrl, providerId) {
  return createHash('sha256')
    .update('drama-warden-share-file-v1\0')
    .update(String(shareUrl))
    .update('\0')
    .update(String(providerId))
    .digest('base64url');
}

function assertRelativeFile(file) {
  const name = String(file?.name || '');
  const relativePath = String(file?.path || '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')
      || !relativePath || relativePath.startsWith('/') || relativePath.includes('\\')
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    const error = new Error('storage provider returned an unsafe shared-file path');
    error.code = 'INVALID_SHARED_FILE';
    throw error;
  }
}

export function publicShareFile(shareUrl, file) {
  const providerId = String(file?.providerId ?? file?.fid ?? file?.id ?? '');
  if (!shareUrl || !providerId) {
    const error = new Error('storage provider returned a shared file without an opaque ID');
    error.code = 'INVALID_SHARED_FILE';
    throw error;
  }
  assertRelativeFile(file);
  return {
    id: shareFileId(shareUrl, providerId),
    path: String(file.path),
    name: String(file.name),
    isDir: false,
    size: Number(file.size || 0),
    mtime: Number(file.mtime || 0),
  };
}

export function resolveShareSelection(shareUrl, selection, currentFiles) {
  if (!Array.isArray(selection) || selection.length === 0 || !Array.isArray(currentFiles)) {
    const error = new Error('save requires a non-empty selection of shared files');
    error.code = 'INVALID_SHARE_SELECTION';
    throw error;
  }
  const available = new Map(currentFiles.map((file) => [
    publicShareFile(shareUrl, file).id,
    file,
  ]));
  const seen = new Set();
  return selection.map((expected) => {
    const id = String(expected?.id || '');
    const file = available.get(id);
    if (!file || seen.has(id)
        || String(expected.path || '') !== String(file.path || '')
        || String(expected.name || '') !== String(file.name || '')
        || (expected.size != null && Number(expected.size) !== Number(file.size || 0))) {
      const error = new Error('save selection contains a stale or invalid shared-file reference');
      error.code = 'INVALID_SHARE_SELECTION';
      throw error;
    }
    seen.add(id);
    return file;
  });
}

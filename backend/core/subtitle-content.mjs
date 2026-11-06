import { inflateRawSync } from 'node:zlib';

export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt']);

function invalidArchive(message) {
  const error = new Error(message);
  error.code = 'INVALID_SUBTITLE_ARCHIVE';
  return error;
}

function safeArchivePath(value) {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return !segments.some((part) => part === '..' || part === '.' || /^[A-Za-z]:/.test(part));
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function findEndRecord(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw invalidArchive('subtitle archive has no valid end record');
}

function readZipSubtitles(buffer) {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw invalidArchive('subtitle archive exceeds the size limit');
  const endOffset = findEndRecord(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (disk || centralDisk || diskEntries !== entryCount || entryCount > 64
      || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralSize > endOffset) {
    throw invalidArchive('subtitle archive uses an unsupported ZIP layout');
  }

  const files = [];
  let offset = centralOffset;
  let totalOutput = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw invalidArchive('subtitle archive has a malformed directory entry');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > buffer.length || (flags & 1) !== 0 || ![0, 8].includes(method)
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || uncompressedSize > MAX_SUBTITLE_BYTES) {
      throw invalidArchive('subtitle archive contains an unsupported entry');
    }
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const unixMode = (externalAttributes >>> 16) & 0xf000;
    if (!safeArchivePath(name) || unixMode === 0xa000) {
      throw invalidArchive('subtitle archive contains an unsafe path');
    }
    offset = entryEnd;
    if (name.endsWith('/')) continue;
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalidArchive('subtitle archive has a malformed file entry');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > buffer.length) throw invalidArchive('subtitle archive entry is truncated');
    const compressed = buffer.subarray(dataOffset, dataEnd);
    let content;
    try {
      content = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_SUBTITLE_BYTES });
    } catch {
      throw invalidArchive('subtitle archive entry could not be decompressed safely');
    }
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
      throw invalidArchive('subtitle archive entry failed integrity checks');
    }
    totalOutput += content.length;
    if (totalOutput > MAX_SUBTITLE_BYTES) throw invalidArchive('subtitle archive expands beyond the size limit');
    files.push({ fileName: name.split('/').at(-1), content });
  }
  return files;
}

function episodeNumber(fileName) {
  const text = String(fileName || '');
  const seasonEpisode = text.match(/[Ss](\d{1,2})\s*[Ee][Pp]?(\d{1,3})/);
  if (seasonEpisode) return { seasonNumber: Number(seasonEpisode[1]), episodeNumber: Number(seasonEpisode[2]) };
  const episode = text.match(/(?:^|[^A-Za-z])(?:episode|ep|e)\s*0*(\d{1,3})(?:[^\d]|$)/i)
    || text.match(/第\s*0*(\d{1,3})\s*集/);
  return episode ? { seasonNumber: null, episodeNumber: Number(episode[1]) } : null;
}

function chooseSubtitle(files, expected) {
  if (!files.length) throw invalidArchive('subtitle download did not contain a supported text subtitle');
  const exact = files.filter((file) => {
    const parsed = episodeNumber(file.fileName);
    return parsed && parsed.episodeNumber === expected.episodeNumber
      && (parsed.seasonNumber == null || parsed.seasonNumber === expected.seasonNumber);
  });
  const selected = exact.length === 1 ? exact[0] : exact.length === 0 && files.length === 1 ? files[0] : null;
  if (!selected) throw invalidArchive('subtitle archive has no unambiguous file for this episode');
  const extension = selected.fileName.slice(selected.fileName.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension) || selected.content.length === 0) {
    throw invalidArchive('subtitle file format is unsupported');
  }
  if (selected.content.includes(0) && !selected.content.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      && !selected.content.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    throw invalidArchive('subtitle file appears to contain binary data');
  }
  return { fileName: selected.fileName.split(/[\\/]/).at(-1), content: selected.content };
}

export function normalizeSubtitleDownload(download, expected) {
  if (!download || typeof download !== 'object') throw new TypeError('subtitle download is invalid');
  const source = Buffer.isBuffer(download.content)
    ? download.content
    : download.content instanceof Uint8Array
      ? Buffer.from(download.content)
      : null;
  if (!source || source.length === 0) throw new TypeError('subtitle provider must return binary content');
  if (source.length > MAX_ARCHIVE_BYTES) throw invalidArchive('subtitle download exceeds the size limit');
  const isZip = source.length >= 4 && source.readUInt32LE(0) === 0x04034b50;
  const files = isZip
    ? readZipSubtitles(source)
    : [{ fileName: String(download.fileName || ''), content: source }];
  return chooseSubtitle(files, expected);
}

export function subtitleFileName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 255 || name.includes('/') || name.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TypeError('subtitle file name is invalid');
  }
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new TypeError('subtitle file extension is unsupported');
  return name;
}

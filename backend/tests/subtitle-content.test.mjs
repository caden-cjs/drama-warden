import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { normalizeSubtitleDownload, subtitleFileName } from '../core/subtitle-content.mjs';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipFile(fileName, content, method = 8, externalAttributes = 0) {
  const name = Buffer.from(fileName);
  const raw = Buffer.from(content);
  const compressed = method === 8 ? deflateRawSync(raw) : raw;
  const crc = crc32(raw);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(externalAttributes, 38);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

test('subtitle download selects the requested episode from a bounded ZIP archive', () => {
  const content = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n');
  const archive = zipFile('Show/Show.S01E03.srt', content);
  const result = normalizeSubtitleDownload({ fileName: 'bundle.zip', content: archive }, {
    seasonNumber: 1,
    episodeNumber: 3,
  });
  assert.equal(result.fileName, 'Show.S01E03.srt');
  assert.deepEqual(result.content, content);
});

test('subtitle ZIP extraction rejects traversal and symlink entries', () => {
  const content = Buffer.from('subtitle');
  assert.throws(() => normalizeSubtitleDownload({
    fileName: 'bad.zip',
    content: zipFile('../outside.srt', content),
  }, { seasonNumber: 1, episodeNumber: 1 }), { code: 'INVALID_SUBTITLE_ARCHIVE' });
  assert.throws(() => normalizeSubtitleDownload({
    fileName: 'link.zip',
    content: zipFile('episode.srt', content, 8, 0xa1ff0000),
  }, { seasonNumber: 1, episodeNumber: 1 }), { code: 'INVALID_SUBTITLE_ARCHIVE' });
});

test('plain subtitle content and output names are bounded to supported text formats', () => {
  assert.deepEqual(normalizeSubtitleDownload({
    fileName: 'source.srt',
    content: Buffer.from('subtitle'),
  }, { seasonNumber: 1, episodeNumber: 1 }), {
    fileName: 'source.srt',
    content: Buffer.from('subtitle'),
  });
  assert.equal(subtitleFileName('Show S01E01.srt'), 'Show S01E01.srt');
  assert.throws(() => subtitleFileName('../Show.srt'), /file name is invalid/);
  assert.throws(() => subtitleFileName('Show.zip'), /extension is unsupported/);
});

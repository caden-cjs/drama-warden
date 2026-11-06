import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scannerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-public-boundary.mjs',
);

async function scanFixture(content, extraFiles = []) {
  const root = await mkdtemp(join(tmpdir(), 'drama-warden-public-boundary-test-'));
  const scannerTarget = join(root, 'scripts', 'check-public-boundary.mjs');
  await mkdir(dirname(scannerTarget), { recursive: true });
  await copyFile(scannerPath, scannerTarget);
  await writeFile(join(root, 'README.md'), content);
  for (const file of extraFiles) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content || 'fixture');
  }
  try {
    return spawnSync(process.execPath, [scannerTarget], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('public boundary accepts blank credential templates and loopback examples', async () => {
  const result = await scanFixture([
    'API_ACCESS_TOKEN=',
    'API origin: http://127.0.0.1:8080',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /public boundary scan passed/);
});

test('public boundary rejects private environment and media files by path', async () => {
  const result = await scanFixture('safe fixture', [
    { path: 'settings/.env.production' },
    { path: 'data/library/episode.mp4' },
    { path: 'uploads/episode.mp4' },
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /settings\/\.env\.production: private environment file/);
  assert.match(result.stderr, /data(?:\/library)?: runtime data/);
  assert.match(result.stderr, /uploads\/episode\.mp4: private data file/);
});

test('public boundary detects generic service tokens without printing their value', async () => {
  const assignment = ['SERVICE', 'TOKEN'].join('_') + '=' + 'x'.repeat(32);
  const result = await scanFixture(assignment);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environment secret assignment/);
  assert.doesNotMatch(result.stderr, /x{8}/);
});

test('public boundary detects temporary AWS access keys', async () => {
  const accessKey = ['AS', 'IA'].join('') + 'A'.repeat(16);
  const result = await scanFixture('credential: ' + accessKey);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS access key/);
  assert.doesNotMatch(result.stderr, /A{8}/);
});

test('public boundary detects common API tokens and secret assignment shapes', async () => {
  const value = 'a'.repeat(52);
  const candidates = [
    { text: 'Google key ' + ['AI', 'za'].join('') + 'b'.repeat(35), finding: /Google API key/ },
    { text: ['sk', 'live'].join('_') + '_' + value, finding: /live payment secret key/ },
    { text: 'npm_' + value, finding: /npm token/ },
    { text: 'pypi-' + value, finding: /PyPI token/ },
    { text: 'Authorization: ' + ['Bear', 'er'].join('') + ' ' + value, finding: /bearer credential/ },
    {
      text: ['eyJ' + 'a'.repeat(12), 'b'.repeat(16), 'c'.repeat(16)].join('.'),
      finding: /JWT credential/,
    },
    {
      text: ['mysql://', 'app:password', '@', 'db.internal'].join(''),
      finding: /credential-bearing URL/,
    },
    {
      text: ['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_') + '=' + value,
      finding: /environment secret assignment/,
    },
    {
      text: '{"client_secret":"' + value + '"}',
      finding: /quoted secret assignment/,
    },
  ];

  for (const candidate of candidates) {
    const result = await scanFixture(candidate.text);
    assert.notEqual(result.status, 0, candidate.finding);
    assert.match(result.stderr, candidate.finding);
    assert.doesNotMatch(result.stderr, /a{8}/i);
  }
});

test('public boundary detects carrier-grade NAT and link-local network addresses', async () => {
  const carrierAddress = ['100', '65', '2', '9'].join('.');
  const linkLocalAddress = ['169', '254', '3', '4'].join('.');
  for (const address of [carrierAddress, linkLocalAddress]) {
    const result = await scanFixture('upstream: http://' + address + ':8080');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private network URL/);
    assert.doesNotMatch(result.stderr, new RegExp(address.replaceAll('.', '\\.')));
  }
});

test('public boundary rejects agent state, authentication directories and captured archives', async () => {
  for (const path of ['.crew/state.json', '.omc/state.json', '.superpowers/state.json', '.run/state.json', '.quarkclouddrive/auth.json', '.115cli/auth.json', '.idea/workspace.xml', 'capture.har', 'backup.rar']) {
    const result = await scanFixture('safe fixture', [{ path }]);
    assert.equal(result.status, 1, path);
    assert.ok(result.stderr.includes(path.split('/')[0]), result.stderr);
  }
});

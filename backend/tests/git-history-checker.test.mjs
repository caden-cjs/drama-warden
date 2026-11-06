import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checkerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-git-history.mjs',
);

function runGit(directory, args) {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

function scanHistory(directory) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'drama-warden-history-test-'));
  runGit(directory, ['init', '--quiet']);
  runGit(directory, ['config', 'user.name', 'Boundary Scanner Test']);
  runGit(directory, ['config', 'user.email', 'boundary-test@example.invalid']);
  return directory;
}

test('history scan handles a repository before its first commit', async () => {
  const directory = await createRepository();
  try {
    const result = scanHistory(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no commits exist yet/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('history scan detects ignored and subsequently deleted private files', async () => {
  const directory = await createRepository();
  try {
    await writeFile(join(directory, 'README.md'), 'safe fixture\n');
    runGit(directory, ['add', 'README.md']);
    runGit(directory, ['commit', '--quiet', '-m', 'safe snapshot']);

    const safe = scanHistory(directory);
    assert.equal(safe.status, 0, safe.stderr);
    assert.match(safe.stdout, /passed \(1 commits\)/);

    await mkdir(join(directory, 'legacy'), { recursive: true });
    await writeFile(join(directory, '.gitattributes'), 'legacy/.env export-ignore\n');
    await writeFile(join(directory, 'legacy', '.env'), 'API_ACCESS_TOKEN=fixture-only\n');
    runGit(directory, ['add', '--all']);
    runGit(directory, ['commit', '--quiet', '-m', 'temporary private fixture']);

    const committed = scanHistory(directory);
    assert.notEqual(committed.status, 0);
    assert.match(committed.stderr, /legacy\/\.env: private environment file/);

    await rm(join(directory, 'legacy', '.env'));
    runGit(directory, ['add', '--all']);
    runGit(directory, ['commit', '--quiet', '-m', 'remove temporary private fixture']);

    const deleted = scanHistory(directory);
    assert.notEqual(deleted.status, 0);
    assert.match(deleted.stderr, /legacy\/\.env: private environment file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const directoryName of ['dist', 'frontend/dist', 'node_modules', 'coverage']) {
  test(`history rejects committed and later deleted artifacts in ${directoryName}`, async () => {
    const directory = await createRepository();
    try {
      const artifact = join(directoryName, 'private.txt');
      const secret = 'fixture-' + 'z'.repeat(40);
      await mkdir(dirname(join(directory, artifact)), { recursive: true });
      await writeFile(join(directory, artifact), secret);
      runGit(directory, ['add', '--all']);
      runGit(directory, ['commit', '--quiet', '-m', 'artifact fixture']);
      await rm(join(directory, artifact));
      runGit(directory, ['add', '--all']);
      runGit(directory, ['commit', '--quiet', '-m', 'remove artifact']);
      const result = scanHistory(directory);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /generated or dependency artifact must not be committed/);
      assert.ok(!result.stderr.includes(secret));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

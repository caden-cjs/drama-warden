import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createServer } from 'node:net';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createEventRepository } from '../core/event-repository.mjs';
import { formatCanonicalEpisodeName } from '../core/media-naming.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { openSqliteDatabase } from '../db/sqlite.mjs';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForHealth(endpoint, child, getOutput) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`server exited before becoming healthy: ${getOutput()}`);
    }
    try {
      const response = await fetch(`${endpoint}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
      lastError = new Error(`health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'timeout'}; ${getOutput()}`);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const forcedStop = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }, 3000);
  forcedStop.unref();
  await exited;
  clearTimeout(forcedStop);
}

function runCli(argumentsList, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/cli.mjs', ...argumentsList], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    timeout.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code ?? signal}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`CLI returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
    if (input == null) child.stdin.end();
    else child.stdin.end(input);
  });
}

test('CLI drives a local follow-up through the authenticated API without cloud accounts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-cli-followup-'));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const integrationBearer = 'cli-test-token';
  const shareRoot = path.join(directory, 'shares');
  const storageRoot = path.join(directory, 'media');
  const releaseDirectory = path.join(shareRoot, 'release');
  const databasePath = path.join(directory, 'catalog.sqlite');
  const pluginPath = path.join(directory, 'fixture-metadata.mjs');
  const envFilePath = path.join(directory, 'cli.env');
  const showName = 'Fixture Show';
  const sourceName = 'Fixture.Show.S01E01.1080p.WEB-DL.mkv';
  const sourceBytes = Buffer.from('CLI follow-up fixture video bytes');
  const repoRoot = process.cwd();
  const sdkUrl = pathToFileURL(path.resolve(repoRoot, 'packages/plugin-sdk/index.mjs')).href;
  let serverOutput = '';
  let child;
  let showId;
  let storageId;
  let eventId;

  try {
    mkdirSync(releaseDirectory, { recursive: true });
    writeFileSync(path.join(releaseDirectory, sourceName), sourceBytes);
    writeFileSync(path.join(releaseDirectory, 'Fixture.Show.S01E02.1080p.WEB-DL.mkv'), 'unselected');
    writeFileSync(path.join(releaseDirectory, 'notes.txt'), 'not a video');
    writeFileSync(envFilePath, '');
    writeFileSync(pluginPath, `import { defineMetadataPlugin } from ${JSON.stringify(sdkUrl)};

export default {
  manifest: { apiVersion: 2 },
  create() {
    return defineMetadataPlugin({
      manifest: {
        id: 'fixture-metadata',
        name: 'Fixture Metadata',
        label: 'Fixture Metadata',
        version: '1.0.0',
      },
      async search({ query, mediaType = 'tv' } = {}) {
        if (mediaType !== 'tv' || query !== ${JSON.stringify(showName)}) return [];
        return [{
          id: 'fixture-series-01',
          externalId: 'fixture-series-01',
          providerId: 'fixture-metadata',
          mediaType: 'tv',
          name: ${JSON.stringify(showName)},
          originalName: ${JSON.stringify(showName)},
        }];
      },
      async detail({ externalId, mediaType = 'tv' } = {}) {
        if (mediaType !== 'tv' || externalId !== 'fixture-series-01') return null;
        return {
          id: externalId,
          name: ${JSON.stringify(showName)},
          mediaType: 'tv',
          seasons: [{ seasonNumber: 1, episodeCount: 1, airDate: '2020-01-01' }],
        };
      },
      async episodes({ externalId, seasonNumber } = {}) {
        if (externalId !== 'fixture-series-01' || Number(seasonNumber) !== 1) return [];
        return [{
          id: 'fixture-episode-01',
          seasonNumber: 1,
          episodeNumber: 1,
          name: 'Fixture Episode 1',
          airDate: '2020-01-01',
        }];
      },
    });
  },
};
`);

    child = spawn(process.execPath, ['backend/server.mjs'], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        PORT: String(port),
        ['API_ACCESS_' + 'TOKEN']: integrationBearer,
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: databasePath,
        LOCAL_STORAGE_ENABLED: 'true',
        LOCAL_STORAGE_ROOT: storageRoot,
        LOCAL_STORAGE_SHARE_ROOT: shareRoot,
        DRAMA_WARDEN_PLUGINS: pluginPath,
        SUBTITLE_WORKER_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
    await waitForHealth(endpoint, child, () => serverOutput);

    const cliEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: directory,
      API_ACCESS_TOKEN: integrationBearer,
      DRAMA_WARDEN_API_URL: endpoint,
      DRAMA_WARDEN_ENV_FILE: envFilePath,
    };
    const disableNetworkMetadata = await fetch(`${endpoint}/api/plugins/tvmaze`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${integrationBearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableNetworkMetadata.status, 200);

    const created = await runCli(['shows', 'create', '--name', showName], {
      cwd: repoRoot,
      env: cliEnv,
    });
    showId = created.show.id;
    assert.ok(Number.isSafeInteger(showId) && showId > 0);

    const metadataResults = await runCli(['metadata', 'search', '--query', showName], {
      cwd: repoRoot,
      env: cliEnv,
    });
    assert.deepEqual(metadataResults.errors, []);
    assert.equal(metadataResults.results[0].providerId, 'fixture-metadata');
    assert.equal(metadataResults.results[0].externalId, 'fixture-series-01');

    const linked = await runCli([
      'shows', 'link-metadata', String(showId),
      '--provider', 'fixture-metadata',
      '--external-id', metadataResults.results[0].externalId,
    ], { cwd: repoRoot, env: cliEnv });
    assert.equal(linked.identity.providerId, 'fixture-metadata');

    const storage = await runCli([
      'storage', 'add', '--show-id', String(showId),
      '--provider', 'local-storage', '--root-path', '/library',
    ], { cwd: repoRoot, env: cliEnv });
    storageId = storage.storage.id;
    assert.ok(Number.isSafeInteger(storageId) && storageId > 0);

    const resources = await runCli([
      'resources', 'search', '--show-id', String(showId), '--storage-id', String(storageId),
    ], { cwd: repoRoot, env: cliEnv });
    const eligible = resources.results.find((item) => item.preview.eligible);
    assert.ok(eligible, 'local resource search should find one eligible video');
    assert.equal(eligible.providerId, 'local-resource');

    const preview = await runCli([
      'followup', 'preview', '--show-id', String(showId), '--storage-id', String(storageId),
      '--share-url-stdin',
    ], { cwd: repoRoot, env: cliEnv, input: eligible.shareUrl });
    assert.equal(preview.preview.eligible, true);
    assert.deepEqual(preview.preview.plan.saveBatch.map((item) => item.episodeNumber), [1]);

    const queued = await runCli([
      'followup', 'queue', '--show-id', String(showId), '--storage-id', String(storageId),
      '--share-url-stdin', '--share-title', eligible.title,
    ], { cwd: repoRoot, env: cliEnv, input: eligible.shareUrl });
    assert.equal(queued.queued, true);
    eventId = queued.event.id;

    const pending = await runCli(['events', 'list', '--status', 'pending'], {
      cwd: repoRoot,
      env: cliEnv,
    });
    assert.ok(pending.items.some((event) => event.id === eventId));

    await assert.rejects(runCli([
      'events', 'process', String(eventId),
    ], { cwd: repoRoot, env: cliEnv }), /pass --confirm-write to continue/);
    const stillPending = await runCli(['events', 'list', '--status', 'pending'], {
      cwd: repoRoot,
      env: cliEnv,
    });
    assert.ok(stillPending.items.some((event) => event.id === eventId));

    const processed = await runCli([
      'events', 'process', String(eventId), '--confirm-write',
    ], { cwd: repoRoot, env: cliEnv });
    assert.equal(processed.ok, true);
    assert.equal(processed.event.status, 'processed');
    assert.deepEqual(processed.episodeNumbers, [1]);
    await stopChild(child);
    child = null;

    const canonicalName = formatCanonicalEpisodeName({
      showName,
      seasonNumber: 1,
      episodeNumber: 1,
      quality: '1080p',
      extension: '.mkv',
    });
    const seasonDirectory = path.join(storageRoot, 'library', 'Season 01');
    assert.deepEqual(readdirSync(seasonDirectory), [canonicalName]);
    assert.deepEqual(readFileSync(path.join(seasonDirectory, canonicalName)), sourceBytes);
    assert.deepEqual(readFileSync(path.join(releaseDirectory, sourceName)), sourceBytes);

    const database = openSqliteDatabase({ filename: databasePath });
    try {
      const episodes = createEpisodeRepository(database);
      const events = createEventRepository(database);
      const storedEpisode = (await episodes.listStorageEpisodes(storageId))
        .find((item) => item.seasonNumber === 1 && item.episodeNumber === 1);
      assert.equal(storedEpisode.status, 'present');
      assert.equal(storedEpisode.assetCount, 1);
      assert.deepEqual(await episodes.listWriteClaims(eventId)
        .then((claims) => claims.map((claim) => claim.status)), ['completed']);
      assert.equal((await events.getById(eventId)).status, 'processed');
      assert.equal((await createShowRepository(database).getById(showId)).name, showName);
    } finally {
      await database.close();
    }
  } finally {
    if (child) await stopChild(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

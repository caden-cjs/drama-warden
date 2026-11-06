import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

test('server composition exposes plugin call history behind bearer authentication', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-server-api-'));
  const port = await availablePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const integrationBearer = 'server-integration-token';
  let output = '';
  const child = spawn(process.execPath, ['backend/server.mjs'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      PORT: String(port),
      ['API_ACCESS_' + 'TOKEN']: integrationBearer,
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: path.join(directory, 'server.sqlite'),
      SUBTITLE_WORKER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

  try {
    await waitForHealth(endpoint, child, () => output);
    const unauthorized = await fetch(`${endpoint}/api/plugin-calls`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${endpoint}/api/plugin-calls?limit=25&offset=0`, {
      headers: { authorization: `Bearer ${integrationBearer}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], limit: 25, offset: 0 });
  } finally {
    await stopChild(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

async function scan(files) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-boundary-'));
  try {
    for (const path of ['scripts', 'backend/core', 'backend/api', 'backend/db', 'backend/plugins', 'packages/plugin-sdk']) {
      await mkdir(join(root, path), { recursive: true });
    }
    const checker = join(root, 'scripts/check-core-plugin-boundary.mjs');
    await copyFile(new URL('../../scripts/check-core-plugin-boundary.mjs', import.meta.url), checker);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('injected ports, shared helpers and SDK imports satisfy the boundary', async () => {
  const result = await scan({
    'backend/core/service.mjs': 'export const run = (plugins) => plugins.invoke();',
    'backend/plugins/metadata/one.mjs': "import '../contract.mjs'; import '../../../packages/plugin-sdk/index.mjs';",
    'backend/plugins/host.mjs': "import './contract.mjs';",
    'packages/plugin-sdk/index.mjs': "export * from './contract.mjs';",
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, path, source, diagnostic] of [
  ['core static import', 'backend/core/service.mjs', "import '../plugins/metadata/one.mjs';", /application imports/],
  ['core dynamic import', 'backend/core/service.mjs', "import('../plugins/metadata/one.mjs');", /application imports/],
  ['provider database import', 'backend/plugins/metadata/one.mjs', "import '../../db/index.mjs';", /plugin imports application/],
  ['provider config import', 'backend/plugins/metadata/one.mjs', "import '../../config.mjs';", /plugin imports application/],
  ['cross-provider import', 'backend/plugins/metadata/one.mjs', "export * from '../notification/one.mjs';", /provider imports another/],
  ['host built-in import', 'backend/plugins/host.mjs', "import './metadata/one.mjs';", /infrastructure imports/],
  ['SDK backend import', 'packages/plugin-sdk/index.mjs', "import '../../backend/db/index.mjs';", /SDK imports application/],
]) {
  test(`boundary rejects ${name}`, async () => {
    const result = await scan({ [path]: source });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, diagnostic);
  });
}

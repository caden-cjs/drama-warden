import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const httpServerSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const databaseLoaderSource = readFileSync(new URL('../db/index.mjs', import.meta.url), 'utf8');

test('SQLite is the default and MCP/MySQL dependencies stay outside the base server path', () => {
  assert.ok(packageManifest.dependencies['better-sqlite3']);
  assert.equal(packageManifest.dependencies.mysql2, undefined);
  assert.ok(packageManifest.optionalDependencies.mysql2);
  assert.ok(packageManifest.optionalDependencies['@modelcontextprotocol/sdk']);
  assert.ok(packageManifest.optionalDependencies.zod);
  assert.equal(packageManifest.scripts.mcp, 'node --env-file-if-exists=.env backend/mcp/server.mjs');

  assert.match(databaseLoaderSource, /driver = process\.env\.DB_DRIVER \|\| 'sqlite'/);
  assert.match(databaseLoaderSource, /await import\('\.\/mysql\.mjs'\)/);
  assert.doesNotMatch(databaseLoaderSource, /from ['"]\.\/mysql\.mjs['"]/);
  assert.doesNotMatch(httpServerSource, /@modelcontextprotocol\/sdk|backend\/mcp\/server\.mjs/);
  assert.doesNotMatch(httpServerSource, /from ['"]\.\/mcp(?:\.mjs)?['"]/);
});

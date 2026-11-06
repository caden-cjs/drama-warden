import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = path.join(repoRoot, 'packages/plugin-sdk');

const appManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const packageManifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const workspacePath = 'packages/plugin-sdk';
const lockedWorkspace = lockfile.packages?.[workspacePath];
const installedWorkspaceLink = lockfile.packages?.[`node_modules/${packageManifest.name}`];

assert.ok(appManifest.workspaces?.includes(workspacePath), 'plugin SDK must remain an application workspace');
assert.equal(
  appManifest.dependencies?.[packageManifest.name],
  packageManifest.version,
  'application dependency must match the plugin SDK workspace version exactly',
);
assert.equal(
  lockfile.packages?.['']?.dependencies?.[packageManifest.name],
  packageManifest.version,
  'package-lock root dependency must match the plugin SDK workspace version exactly',
);
assert.equal(lockedWorkspace?.name, packageManifest.name, 'package-lock must link the expected plugin SDK workspace');
assert.equal(
  lockedWorkspace?.version,
  packageManifest.version,
  'package-lock workspace version must match the plugin SDK manifest',
);
assert.equal(installedWorkspaceLink?.resolved, workspacePath, 'package-lock must link the SDK dependency to its workspace');
assert.equal(installedWorkspaceLink?.link, true, 'package-lock SDK dependency must remain a workspace link');

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'drama-warden-plugin-sdk-'));
const consumerRoot = path.join(tempRoot, 'consumer');

function run(command, args, { cwd = repoRoot } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      command + ' ' + args.join(' ') + ' failed with exit code ' + result.status,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

try {
  const expectedTarball = packageManifest.name.replace(/^@/, '').replace('/', '-') + '-' + packageManifest.version + '.tgz';
  const packOutput = run('npm', [
    'pack',
    `--workspace=${packageManifest.name}`,
    '--pack-destination', tempRoot,
    '--silent',
  ]);
  const tarballName = packOutput.trim().split(/\r?\n/).at(-1);
  assert.equal(tarballName, expectedTarball, 'npm pack must produce the SDK tarball');
  const tarballPath = path.join(tempRoot, tarballName);

  const packedFiles = run('tar', ['-tzf', tarballPath]).trim().split(/\r?\n/);
  assert.ok(packedFiles.every((file) => file.startsWith('package/')), 'SDK tarball contains an unexpected archive path');
  for (const requiredFile of [
    'package/package.json',
    'package/index.mjs',
    'package/index.d.ts',
    'package/README.md',
    'package/LICENSE',
  ]) {
    assert.ok(packedFiles.includes(requiredFile), 'published SDK package is missing ' + requiredFile);
  }
  assert.ok(!packedFiles.some((file) => file.includes('/type-tests/')), 'SDK type fixtures must stay out of the package');

  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({ name: 'plugin-sdk-consumer', private: true, type: 'module' }));
  const installedPackage = path.join(consumerRoot, 'node_modules/@drama-warden/plugin-sdk');
  mkdirSync(installedPackage, { recursive: true });
  run('tar', ['-xzf', tarballPath, '-C', installedPackage, '--strip-components=1']);
  copyFileSync(
    path.join(packageRoot, 'type-tests/consumer.mts'),
    path.join(consumerRoot, 'consumer.mts'),
  );

  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import { readFileSync } from 'node:fs'; import * as sdk from '@drama-warden/plugin-sdk'; " +
      "const expected = ['METADATA_CAPABILITIES','PLUGIN_API_VERSION','PLUGIN_KINDS','RESOURCE_CAPABILITIES'," +
      "'STORAGE_CAPABILITIES','STORAGE_OPTIONAL_CAPABILITIES','STORAGE_REMOVE_MODES','SUBTITLE_CAPABILITIES'," +
      "'assertPlugin','defineMetadataPlugin','definePlugin','defineResourcePlugin','defineStoragePlugin','defineSubtitlePlugin'].sort(); " +
      "const expectedTypes = ['CapabilityDomains','ConfigField','ConfigSchema','JsonObject','MetadataCandidate'," +
      "'MetadataDetail','MetadataDetailInput','MetadataEpisode','MetadataEpisodesInput','MetadataSearchInput'," +
      "'MetadataSeason','PluginAction','PluginConfig','PluginContext','PluginDefinition','PluginFactory'," +
      "'PluginKind','PluginLifecycleOptions','PluginManifest','PluginManifestInput','ResourceCandidate'," +
      "'ResourceSearchInput','ResourceSearchResult','StorageActionMap','StorageCapability','StorageCleanInput'," +
      "'StorageCleanOptions','StorageContract','StorageFileEntry','StorageListInput','StorageListOptions'," +
      "'StorageListSharedFilesInput','StorageListing','StorageMoveInput','StoragePathInput','StorageRenameInput'," +
      "'StorageRenameItem','StorageRenameManyInput','StorageRemoveInput','StorageRemoveMode','StorageRemoveModes'," +
      "'StorageSaveInput','StorageSaveResult','StorageShareFile','StorageSharedListing','StorageWriteSidecarInput'," +
      "'SubtitleCandidate','SubtitleDownloadInput','SubtitleDownloadResult','SubtitleSearchInput'].sort(); " +
      "const runtimeNames = Object.keys(sdk).sort(); " +
      "const declarations = readFileSync('node_modules/@drama-warden/plugin-sdk/index.d.ts', 'utf8'); " +
      "const declaredNames = [...declarations.matchAll(/^export declare (?:const|function)\\s+([A-Za-z_$][\\w$]*)/gm)]" +
      ".map(([, name]) => name).sort(); " +
      "const declaredTypes = [...declarations.matchAll(/^export (?:type|interface)\\s+([A-Za-z_$][\\w$]*)/gm)]" +
      ".map(([, name]) => name).sort(); " +
      "if (JSON.stringify(runtimeNames) !== JSON.stringify(expected) || " +
      "JSON.stringify(declaredNames) !== JSON.stringify(expected) || " +
      "JSON.stringify(declaredTypes) !== JSON.stringify(expectedTypes)) " +
      "throw new Error('SDK runtime/type exports do not match the reviewed public API'); " +
      "const { PLUGIN_API_VERSION, defineMetadataPlugin } = sdk; " +
      "const plugin = defineMetadataPlugin({manifest:{id:'packed-metadata',version:'1.0.0'}, " +
      "search:async()=>[],detail:async()=>null,episodes:async()=>[]}); " +
      "if (PLUGIN_API_VERSION !== 2 || plugin.apiVersion !== 2) process.exit(1);",
  ], { cwd: consumerRoot });

  const compilerPackages = ['typescript-5.0', 'typescript'];
  for (const compilerPackage of compilerPackages) {
    const compilerRoot = path.join(repoRoot, 'node_modules', compilerPackage);
    const compilerVersion = JSON.parse(readFileSync(path.join(compilerRoot, 'package.json'), 'utf8')).version;
    run(process.execPath, [
      path.join(compilerRoot, 'bin/tsc'),
      '--noEmit',
      '--strict',
      '--target', 'ES2022',
      '--module', 'Node16',
      '--moduleResolution', 'Node16',
      'consumer.mts',
    ], { cwd: consumerRoot });
    process.stdout.write(`plugin SDK TypeScript consumer check passed (TypeScript ${compilerVersion})\n`);
  }
  process.stdout.write(`plugin SDK ${packageManifest.version} workspace, tarball runtime and public export checks passed\n`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

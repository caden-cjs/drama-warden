import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('run this check through npm so npm_execpath is available');
}

function pack(cwd) {
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || 'npm pack dry run failed');
  }
  try {
    const report = JSON.parse(result.stdout);
    const files = report?.[0]?.files;
    if (!Array.isArray(files)) throw new Error('npm pack dry run did not report packaged files');
    return files;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('npm pack dry run did not return valid JSON');
    throw error;
  }
}

function isExcludedPath(value) {
  const filePath = String(value || '').replaceAll('\\', '/');
  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '.env'
      || segment === '.npmrc'
      || segment === '.pypirc'
      || segment === '.ssh'
      || segment === 'credentials'
      || segment === 'secrets'
      || segment === 'backups'
      || (segment.startsWith('.env.') && segment !== '.env.example'))) return true;
  if (segments.includes('data') || segments.includes('coverage')) return true;
  if (filePath.startsWith('config/') && filePath !== 'config/config.example.yaml') return true;
  if (/(^|\/)(?:\.git|\.github|\.deploy-backups|\.agents|\.codex|\.claude|\.crew|\.omc|\.superpowers|\.run|\.quarkclouddrive|\.115cli|node_modules)(?:\/|$)/.test(filePath)) {
    return true;
  }
  return /\.(?:sqlite(?:-(?:wal|shm))?|db|pem|key|p12|pfx|jks|keystore|mobileprovision|mysql_history|dump|backup|bak|log|zip|tar|tgz|gz|7z|rar|har|strm|m3u8?|mp4|mkv|avi|mov|webm|wmv|m4v|mpg|mpeg|flv|mp3|wav|flac|m4a|aac|ogg|opus|srt|ass|ssa|vtt|sub)$/i.test(filePath);
}

function verifyNoExcludedFiles(files, label) {
  const excludedFiles = files.map((file) => file.path).filter(isExcludedPath);
  if (excludedFiles.length) {
    throw new Error(`${label} would package excluded files: ${excludedFiles.join(', ')}`);
  }
}

function verifyRequiredFiles(files, required, label) {
  const packagedPaths = new Set(files.map((file) => file.path));
  for (const path of required) {
    if (!packagedPaths.has(path)) {
      throw new Error(`${label} is missing required public file: ${path}`);
    }
  }
}

const appFiles = pack(process.cwd());
verifyNoExcludedFiles(appFiles, 'application package');
verifyRequiredFiles(appFiles, [
  '.env.example',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/PUBLIC-RELEASE.md',
  'config/config.example.yaml',
  'backend/config.mjs',
  'scripts/start.mjs',
], 'application package');

const sdkDirectory = fileURLToPath(new URL('../packages/plugin-sdk/', import.meta.url));
const sdkFiles = pack(sdkDirectory);
verifyNoExcludedFiles(sdkFiles, 'plugin SDK');
verifyRequiredFiles(sdkFiles, ['index.mjs', 'index.d.ts', 'README.md', 'LICENSE'], 'plugin SDK');

process.stdout.write(
  `npm package boundary check passed (application ${appFiles.length} files; plugin SDK ${sdkFiles.length} files)\n`,
);

import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const forbiddenSegments = new Set([
  '.ssh', '.deploy-backups', '.claude', '.codex', '.agents', '.vscode',
  'credentials', 'secrets', 'backups', '.crew', '.omc', '.superpowers',
  '.run', '.quarkclouddrive', '.115cli', '.idea',
]);
const forbiddenExtensions = new Set([
  '.sqlite', '.db', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
  '.mobileprovision', '.dump', '.backup', '.bak', '.log', '.zip', '.tgz',
  '.tar', '.gz', '.7z', '.rar', '.har', '.strm', '.m3u', '.m3u8', '.mp4', '.mkv',
  '.avi', '.mov', '.webm', '.wmv', '.m4v', '.mpg', '.mpeg', '.flv',
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus',
  '.srt', '.ass', '.ssa', '.vtt', '.sub',
]);
const privateIpv4 = String.raw`(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}|169\.254\.(?:\d{1,3}\.)\d{1,3})`;
const checks = [
  ['Git LFS pointer', /^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/m],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['live payment secret key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['PyPI token', /\bpypi-[A-Za-z0-9_-]{40,}\b/],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/i],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/],
  ['Slack webhook', /https?:\/\/hooks\.slack\.com\/services\/[A-Z0-9/]{30,}/i],
  ['Feishu bot webhook', /https?:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Fa-f0-9-]{24,}/i],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['cloud-drive share URL', /https?:\/\/(?:pan\.quark\.cn\/s\/|115\.com\/s\/)[A-Za-z0-9_-]{6,}/i],
  ['credential-bearing URL', /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{4,}@/i],
  ['private network URL', new RegExp('https?:\\/\\/' + privateIpv4 + '(?::\\d+)?\\b', 'i')],
  ['private network address', new RegExp('\\b' + privateIpv4 + '\\b')],
  ['quoted secret assignment', /(?:api[_-]?key|(?:[a-z0-9]+[_-])?access[_-]?token|(?:[a-z0-9]+[_-])?token|(?:[a-z0-9]+[_-])?secret(?:[_-]?(?:access[_-]?)?key)?|password|cookie)["']?[ \t]*[:=][ \t]*["']([A-Za-z0-9_+./=-]{24,})["']/i],
  ['environment secret assignment', /^\s*[A-Z0-9_]*(?:API[_-]?KEY|(?:ACCESS[_-]?)?TOKEN|(?:CLIENT[_-]?)?SECRET(?:[_-]?(?:ACCESS[_-]?)?KEY)?|PASSWORD|COOKIE)[ \t]*=[ \t]*([A-Za-z0-9_+=-]{24,})(?:\s|$|#|;)/im],
  ['personal home path', /(?:^|[\s"'=(])\/home\/[^/\s"')]+\//],
  ['NAS Panel host path', new RegExp('/' + 'root/projects/' + 'nas-panel|/' + 'var/lib/' + 'nas-panel')],
];

function pathProblem(filePath, entry) {
  const normalized = filePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const basename = segments.at(-1) || '';
  if (segments.some((segment) => forbiddenSegments.has(segment))) return 'private directory';
  if (basename === '.env' || basename === '.npmrc' || basename === '.pypirc'
      || (basename.startsWith('.env.') && basename !== '.env.example')) {
    return 'private environment file';
  }
  if (normalized.startsWith('config/') && normalized !== 'config/config.example.yaml') {
    return 'private runtime configuration';
  }
  if (normalized === 'data/.gitkeep') return null;
  if (segments.includes('data') && !(normalized === 'data' && entry.isDirectory())) {
    return 'runtime data';
  }
  if (forbiddenExtensions.has(extname(basename).toLowerCase())) return 'private data file';
  if (basename === '.DS_Store' || entry.isSymbolicLink()) return 'local filesystem artifact';
  return null;
}

async function walk(directory, findings, stats) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const filePath = relative(root, absolutePath).replaceAll('\\', '/');
    const skipDirectory = entry.isDirectory() && (
      entry.name === '.git'
      || entry.name === 'node_modules'
      || filePath === 'dist'
      || filePath === 'coverage'
      || filePath === 'frontend/dist'
    );
    if (skipDirectory && skippedDirectories.has(entry.name)) continue;
    const fileInfo = await lstat(absolutePath);
    const problem = pathProblem(filePath, fileInfo);
    if (problem) {
      findings.push({ filePath, problem });
      continue;
    }
    if (fileInfo.isDirectory()) {
      await walk(absolutePath, findings, stats);
      continue;
    }
    if (!fileInfo.isFile()) continue;
    if (fileInfo.size > 8 * 1024 * 1024) {
      findings.push({ filePath, problem: 'large file requires manual review' });
      continue;
    }
    stats.files += 1;
    const content = await readFile(absolutePath);
    if (content.includes(0)) {
      findings.push({ filePath, problem: 'binary file requires manual review' });
      continue;
    }
    const text = content.toString('utf8');
    for (const [label, pattern] of checks) {
      if (pattern.test(text)) findings.push({ filePath, problem: label });
    }
  }
}

const findings = [];
const stats = { files: 0 };
await walk(root, findings, stats);
if (findings.length) {
  for (const item of findings) {
    process.stderr.write(item.filePath + ': ' + item.problem + '\n');
  }
  process.exitCode = 1;
} else {
  process.stdout.write('public boundary scan passed (' + stats.files + ' files)\n');
}

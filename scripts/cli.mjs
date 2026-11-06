import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = `Usage:
  npm run cli -- shows list
  npm run cli -- metadata search --query TEXT [--media-type tv|movie] [--limit N]
  npm run cli -- shows create --name TEXT [--media-type tv|movie] [--aliases JSON] [--finished]
  npm run cli -- shows link-metadata ID --provider ID --external-id ID [--media-type tv|movie]
  npm run cli -- storage list --show-id ID
  npm run cli -- storage add --show-id ID --provider ID --root-path PATH [--disabled]
  npm run cli -- storage scan --show-id ID --storage-id ID
  npm run cli -- automation scan
  npm run cli -- resources search --show-id ID --storage-id ID [--query TEXT] [--limit N]
  npm run cli -- followup preview --show-id ID --storage-id ID --share-url-stdin [--share-title TEXT]
  npm run cli -- followup queue --show-id ID --storage-id ID --share-url-stdin [--share-title TEXT]
  npm run cli -- events list [--status STATUS] [--limit N]
  npm run cli -- events process ID --confirm-write

The CLI calls the same authenticated REST API used by the management panel.
It loads .env when present; use DRAMA_WARDEN_ENV_FILE to select another file.
Share URLs are read from stdin so they do not appear in shell history.
Processing an event may write media through its storage provider.`;

const valueOptions = new Set([
  '--show-id', '--storage-id', '--query', '--limit', '--share-title', '--status',
  '--name', '--media-type', '--aliases', '--provider', '--external-id', '--root-path',
]);
const booleanOptions = new Set([
  '--share-url-stdin', '--confirm-write', '--finished', '--disabled',
]);

function parseArguments(argumentsList) {
  if (argumentsList.length === 0 || argumentsList.includes('--help')
      || argumentsList.includes('-h')) {
    return { help: true };
  }

  const [group, action, ...rest] = argumentsList;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (Object.hasOwn(options, argument)) {
      throw new TypeError(`${argument} may only be provided once`);
    }
    if (booleanOptions.has(argument)) {
      options[argument] = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new TypeError(`unknown option: ${argument}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`${argument} requires a value`);
    options[argument] = value;
    index += 1;
  }
  return { group, action, positional, options };
}

function loadEnvironmentFile(env) {
  if (env !== process.env) return env;
  const filename = env.DRAMA_WARDEN_ENV_FILE || '.env';
  if (!existsSync(filename)) {
    if (env.DRAMA_WARDEN_ENV_FILE) throw new Error('configured environment file does not exist');
    return env;
  }
  process.loadEnvFile(filename);
  return process.env;
}

function positiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${optionName} must be a positive integer`);
  }
  return number;
}

function requiredOption(options, key) {
  const value = options[key];
  if (value == null || String(value).trim() === '') {
    throw new TypeError(`${key} is required`);
  }
  return value;
}

function mediaTypeOption(options) {
  const mediaType = options['--media-type'] || 'tv';
  if (!['tv', 'movie'].includes(mediaType)) {
    throw new TypeError('--media-type must be tv or movie');
  }
  return mediaType;
}

async function readShareUrl(input = process.stdin) {
  if (input.isTTY) {
    throw new TypeError('pipe the share URL to stdin and pass --share-url-stdin');
  }
  let value = '';
  for await (const chunk of input) {
    value += chunk.toString('utf8');
    if (value.length > 8192) throw new TypeError('share URL input is too large');
  }
  const shareUrl = value.trim();
  if (!shareUrl) throw new TypeError('share URL input is empty');
  return shareUrl;
}

function getApiBase(env) {
  const value = env.DRAMA_WARDEN_API_URL || 'http://127.0.0.1:8080';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('DRAMA_WARDEN_API_URL must be an HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('DRAMA_WARDEN_API_URL must be an HTTP(S) origin without credentials or a path');
  }
  return url;
}

async function requestApi(path, { method = 'GET', body, env, fetchImpl = fetch } = {}) {
  const token = String(env.API_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('API_ACCESS_TOKEN is required; configure it in .env or the process environment');
  const url = new URL(path, getApiBase(env));
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(`API request failed: ${String(error?.message || error)}`);
  }

  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`API returned a non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const code = result?.code ? ` (${result.code})` : '';
    const message = result?.error || `HTTP ${response.status}`;
    throw new Error(`${message}${code}`);
  }
  return result;
}

async function buildRequest(command, options, positional) {
  if (groupIs(command, 'shows', 'list')) {
    assertNoOptions(options);
    assertNoPositionals(positional);
    return { path: '/api/shows', method: 'GET' };
  }
  if (groupIs(command, 'shows', 'get')) {
    assertNoOptions(options);
    if (positional.length !== 1) throw new TypeError('shows get requires one show ID');
    const showId = positiveInteger(positional[0], 'show ID');
    return { path: `/api/shows/${showId}`, method: 'GET' };
  }
  if (groupIs(command, 'shows', 'create')) {
    assertAllowedOptions(options, ['--name', '--media-type', '--aliases', '--finished']);
    assertNoPositionals(positional);
    const body = {
      name: requiredOption(options, '--name'),
      mediaType: mediaTypeOption(options),
      finished: options['--finished'] === true,
      aliases: [],
    };
    if (options['--aliases'] != null) {
      try {
        body.aliases = JSON.parse(options['--aliases']);
      } catch {
        throw new TypeError('--aliases must be a JSON array of strings');
      }
      if (!Array.isArray(body.aliases) || body.aliases.some((alias) => typeof alias !== 'string')) {
        throw new TypeError('--aliases must be a JSON array of strings');
      }
    }
    return { path: '/api/shows', method: 'POST', body };
  }
  if (groupIs(command, 'shows', 'link-metadata')) {
    assertAllowedOptions(options, ['--provider', '--external-id', '--media-type']);
    if (positional.length !== 1) throw new TypeError('shows link-metadata requires one show ID');
    const showId = positiveInteger(positional[0], 'show ID');
    const body = {
      providerId: requiredOption(options, '--provider'),
      externalId: requiredOption(options, '--external-id'),
      mediaType: mediaTypeOption(options),
    };
    return { path: `/api/shows/${showId}/metadata-identities`, method: 'POST', body };
  }
  if (groupIs(command, 'metadata', 'search')) {
    assertAllowedOptions(options, ['--query', '--media-type', '--limit']);
    assertNoPositionals(positional);
    const query = new URLSearchParams({
      q: requiredOption(options, '--query'),
      mediaType: mediaTypeOption(options),
    });
    if (options['--limit'] != null) {
      const limit = positiveInteger(options['--limit'], '--limit');
      if (limit > 50) throw new TypeError('--limit must be 50 or less');
      query.set('limit', String(limit));
    }
    return { path: `/api/metadata/search?${query}`, method: 'GET' };
  }
  if (groupIs(command, 'storage', 'list')) {
    assertAllowedOptions(options, ['--show-id']);
    assertNoPositionals(positional);
    const showId = positiveInteger(requiredOption(options, '--show-id'), '--show-id');
    return { path: `/api/shows/${showId}/storages`, method: 'GET' };
  }
  if (groupIs(command, 'storage', 'add')) {
    assertAllowedOptions(options, ['--show-id', '--provider', '--root-path', '--disabled']);
    assertNoPositionals(positional);
    const showId = positiveInteger(requiredOption(options, '--show-id'), '--show-id');
    const body = {
      providerId: requiredOption(options, '--provider'),
      rootPath: requiredOption(options, '--root-path'),
      enabled: options['--disabled'] !== true,
    };
    return { path: `/api/shows/${showId}/storages`, method: 'POST', body };
  }
  if (groupIs(command, 'storage', 'scan')) {
    assertAllowedOptions(options, ['--show-id', '--storage-id']);
    assertNoPositionals(positional);
    const showId = positiveInteger(requiredOption(options, '--show-id'), '--show-id');
    const storageId = positiveInteger(requiredOption(options, '--storage-id'), '--storage-id');
    return { path: `/api/shows/${showId}/storages/${storageId}/scan`, method: 'POST' };
  }
  if (groupIs(command, 'automation', 'scan')) {
    assertNoOptions(options);
    assertNoPositionals(positional);
    return { path: '/api/automation/scan', method: 'POST' };
  }
  if (groupIs(command, 'resources', 'search')) {
    assertAllowedOptions(options, ['--show-id', '--storage-id', '--query', '--limit']);
    assertNoPositionals(positional);
    const showId = positiveInteger(requiredOption(options, '--show-id'), '--show-id');
    const storageId = positiveInteger(requiredOption(options, '--storage-id'), '--storage-id');
    const body = { storageId };
    if (options['--query'] != null) body.query = options['--query'];
    if (options['--limit'] != null) {
      body.limit = positiveInteger(options['--limit'], '--limit');
      if (body.limit > 20) throw new TypeError('--limit must be 20 or less');
    }
    return { path: `/api/shows/${showId}/resources/search`, method: 'POST', body };
  }
  if (groupIs(command, 'followup', 'preview') || groupIs(command, 'followup', 'queue')) {
    assertAllowedOptions(options, ['--show-id', '--storage-id', '--share-url-stdin', '--share-title']);
    assertNoPositionals(positional);
    if (!options['--share-url-stdin']) {
      throw new TypeError('pass --share-url-stdin to read the share URL from stdin');
    }
    const showId = positiveInteger(requiredOption(options, '--show-id'), '--show-id');
    const storageId = positiveInteger(requiredOption(options, '--storage-id'), '--storage-id');
    const shareUrl = await readShareUrl();
    const body = { storageId, shareUrl };
    if (options['--share-title'] != null) body.shareTitle = options['--share-title'];
    return {
      path: `/api/shows/${showId}/followup/${command.action}`,
      method: 'POST',
      body,
    };
  }
  if (groupIs(command, 'events', 'list')) {
    assertAllowedOptions(options, ['--status', '--limit']);
    assertNoPositionals(positional);
    const query = new URLSearchParams();
    if (options['--status'] != null) query.set('status', options['--status']);
    if (options['--limit'] != null) {
      query.set('limit', String(positiveInteger(options['--limit'], '--limit')));
    }
    const suffix = query.size ? `?${query}` : '';
    return { path: `/api/events${suffix}`, method: 'GET' };
  }
  if (groupIs(command, 'events', 'process')) {
    assertAllowedOptions(options, ['--confirm-write']);
    if (positional.length !== 1) throw new TypeError('events process requires one event ID');
    if (!options['--confirm-write']) {
      throw new TypeError('event processing can write media; pass --confirm-write to continue');
    }
    const eventId = positiveInteger(positional[0], 'event ID');
    return { path: `/api/events/${eventId}/process`, method: 'POST' };
  }
  throw new TypeError('unknown command; run `npm run cli -- --help` for usage');
}

function groupIs(command, group, action) {
  return command.group === group && command.action === action;
}

function assertNoOptions(options) {
  if (Object.keys(options).length) throw new TypeError(`unexpected option: ${Object.keys(options)[0]}`);
}

function assertNoPositionals(positional) {
  if (positional.length) throw new TypeError(`unexpected argument: ${positional[0]}`);
}

function assertAllowedOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new TypeError(`unexpected option: ${key}`);
  }
}

export async function runCliCommand(argumentsList = process.argv.slice(2), env = process.env) {
  const command = parseArguments(argumentsList);
  if (command.help) {
    process.stdout.write(usage + '\n');
    return null;
  }

  env = loadEnvironmentFile(env);
  const request = await buildRequest(command, command.options, command.positional);
  const result = await requestApi(request.path, { ...request, env });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (groupIs(command, 'events', 'process') && result?.ok !== true) {
    process.stderr.write('Event did not finish successfully. Check its status and the destination before retrying.\n');
    process.exitCode = 2;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCliCommand().catch((error) => {
    process.stderr.write(`drama-warden: ${error.message}\n`);
    process.exitCode = 1;
  });
}

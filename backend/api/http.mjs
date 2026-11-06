import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 256 * 1024;
const PRIVATE_FIELD_RE = /(?:url|uri|link|token|cookie|password|secret|authorization)/i;

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function httpError(status, message, code = 'request_failed') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function hasValidToken(request, token) {
  if (!token) return false;
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJson(request) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw httpError(415, 'content type must be application/json', 'unsupported_media_type');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, 'request body is too large', 'payload_too_large');
    }
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'request body must be valid JSON', 'invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'request body must be a JSON object', 'invalid_body');
  }
  return value;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = PRIVATE_FIELD_RE.test(key) ? '[redacted]' : redactValue(child);
  }
  return result;
}

function publicEvent(event) {
  return event ? { ...event, payload: redactValue(event.payload) } : event;
}

function publicSubtitleJob(job) {
  if (!job) return job;
  const retryable = job.status === 'failed' && job.writeStartedAt == null;
  const { writeStartedAt, ...publicJobValue } = job;
  return { ...publicJobValue, retryable };
}

function publicProviderFailures(error) {
  if (error?.code !== 'ALL_RESOURCE_PROVIDERS_FAILED' || !Array.isArray(error.providers)) {
    return null;
  }
  return error.providers.map((provider) => {
    const errorCode = String(provider?.errorCode || 'RESOURCE_PROVIDER_ERROR');
    return {
      providerId: String(provider?.providerId || 'unknown'),
      errorCode: /^[A-Z0-9_-]{1,64}$/i.test(errorCode)
        ? errorCode
        : 'RESOURCE_PROVIDER_ERROR',
    };
  });
}

export function createApiHandler({
  shows,
  episodes,
  events,
  metadata,
  storageCatalog,
  followup,
  resourceDiscovery,
  automation,
  scheduler,
  subtitles,
  subtitleWorker,
  listPlugins,
  pluginCalls,
  runtimeSettings,
  pluginSettings,
  token = process.env.API_ACCESS_TOKEN || '',
} = {}) {
  if (!shows || !episodes || !events || !metadata || !storageCatalog || !followup
      || !resourceDiscovery || !automation || !scheduler || !subtitles || !subtitleWorker
      || typeof listPlugins !== 'function') {
    throw new TypeError('show, episode, event, metadata, storage catalog, follow-up, discovery, automation, scheduler, subtitle, and plugin services are required');
  }

  return async function handleApi(request, response) {
    if (!hasValidToken(request, token)) {
      send(response, 401, { error: 'unauthorized', code: 'unauthorized' });
      return;
    }

    const url = new URL(request.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (path === '/api/settings/runtime' && request.method === 'GET') {
        if (!runtimeSettings || typeof runtimeSettings.get !== 'function') {
          throw httpError(503, 'runtime settings are unavailable', 'runtime_settings_unavailable');
        }
        send(response, 200, await runtimeSettings.get());
        return;
      }
      if (path === '/api/settings/runtime' && request.method === 'PUT') {
        if (!runtimeSettings || typeof runtimeSettings.update !== 'function') {
          throw httpError(503, 'runtime settings are unavailable', 'runtime_settings_unavailable');
        }
        const result = await runtimeSettings.update(await readJson(request));
        scheduler.updateSettings({
          enabled: result.settings.followupAutomationEnabled,
          intervalMinutes: result.settings.followupScanIntervalMinutes,
          autoProcess: result.settings.followupAutoProcess,
        });
        send(response, 200, result);
        return;
      }
      if (path === '/api/settings/runtime' && request.method === 'DELETE') {
        if (!runtimeSettings || typeof runtimeSettings.reset !== 'function') {
          throw httpError(503, 'runtime settings are unavailable', 'runtime_settings_unavailable');
        }
        const result = await runtimeSettings.reset();
        scheduler.updateSettings({
          enabled: result.settings.followupAutomationEnabled,
          intervalMinutes: result.settings.followupScanIntervalMinutes,
          autoProcess: result.settings.followupAutoProcess,
        });
        send(response, 200, result);
        return;
      }

      if (path === '/api/plugins' && request.method === 'GET') {
        send(response, 200, {
          items: pluginSettings?.list
            ? pluginSettings.list()
            : listPlugins({ enabledOnly: false }),
        });
        return;
      }

      if (path === '/api/plugin-calls' && request.method === 'GET') {
        if (!pluginCalls || typeof pluginCalls.list !== 'function') {
          throw httpError(503, 'plugin call log is unavailable', 'plugin_call_log_unavailable');
        }
        const filters = {
          pluginId: url.searchParams.get('pluginId') || undefined,
          capability: url.searchParams.get('capability') || undefined,
          source: url.searchParams.get('source') || undefined,
          correlationId: url.searchParams.get('correlationId') || undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
          offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0,
        };
        if (url.searchParams.has('ok')) {
          const ok = url.searchParams.get('ok');
          if (!['true', 'false'].includes(ok)) {
            throw httpError(400, 'ok must be true or false', 'invalid_ok_filter');
          }
          filters.ok = ok === 'true';
        }
        const items = await pluginCalls.list(filters);
        send(response, 200, { items, limit: filters.limit, offset: filters.offset });
        return;
      }

      const pluginActionMatch = path.match(/^\/api\/plugins\/([^/]+)\/(move|monitor|reset)$/);
      if (pluginActionMatch) {
        const pluginId = pluginActionMatch[1];
        const action = pluginActionMatch[2];
        if (!pluginSettings) {
          throw httpError(503, 'plugin management is unavailable', 'plugin_management_unavailable');
        }
        if (action === 'move' && request.method === 'POST') {
          const input = await readJson(request);
          send(response, 200, {
            items: await pluginSettings.move(pluginId, input.direction),
          });
          return;
        }
        if (action === 'monitor' && request.method === 'POST') {
          send(response, 200, { result: await pluginSettings.monitor(pluginId) });
          return;
        }
        if (action === 'reset' && request.method === 'POST') {
          send(response, 200, await pluginSettings.reset(pluginId));
          return;
        }
      }

      const pluginMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
      if (pluginMatch && request.method === 'PUT') {
        if (!pluginSettings || typeof pluginSettings.update !== 'function') {
          throw httpError(503, 'plugin management is unavailable', 'plugin_management_unavailable');
        }
        const input = await readJson(request);
        send(response, 200, {
          items: await pluginSettings.update(pluginMatch[1], input),
        });
        return;
      }

      if (path === '/api/subtitles/status' && request.method === 'GET') {
        send(response, 200, {
          worker: subtitleWorker.status(),
          providers: listPlugins({ kind: 'subtitle-provider', enabledOnly: true })
            .map((plugin) => ({ id: plugin.id, label: plugin.label })),
        });
        return;
      }

      if (path === '/api/subtitle-jobs' && request.method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        const showId = url.searchParams.get('showId') || undefined;
        const limit = url.searchParams.get('limit') || undefined;
        send(response, 200, {
          items: (await subtitles.list({ status, showId, limit })).map(publicSubtitleJob),
        });
        return;
      }

      const showSubtitleJobsMatch = path.match(/^\/api\/shows\/([^/]+)\/subtitle-jobs$/);
      if (showSubtitleJobsMatch && request.method === 'POST') {
        const showId = positiveId(showSubtitleJobsMatch[1]);
        if (!showId) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        const input = await readJson(request);
        const result = await subtitles.queue({ ...input, showId });
        send(response, result.queued ? 202 : 200, {
          queued: result.queued,
          job: publicSubtitleJob(result.job),
        });
        return;
      }

      const subtitleJobMatch = path.match(/^\/api\/subtitle-jobs\/([^/]+)(?:\/(retry))?$/);
      if (subtitleJobMatch && request.method === 'GET' && !subtitleJobMatch[2]) {
        const id = positiveId(subtitleJobMatch[1]);
        if (!id) throw httpError(400, 'subtitle job id must be a positive integer', 'invalid_subtitle_job_id');
        const job = await subtitles.get(id);
        if (!job) throw httpError(404, 'subtitle job not found', 'subtitle_job_not_found');
        send(response, 200, { job: publicSubtitleJob(job) });
        return;
      }
      if (subtitleJobMatch && request.method === 'POST' && subtitleJobMatch[2]) {
        const id = positiveId(subtitleJobMatch[1]);
        if (!id) throw httpError(400, 'subtitle job id must be a positive integer', 'invalid_subtitle_job_id');
        send(response, 200, { job: publicSubtitleJob(await subtitles.retry(id)) });
        return;
      }

      if (path === '/api/automation/status' && request.method === 'GET') {
        send(response, 200, { automation: scheduler.status() });
        return;
      }
      if (path === '/api/automation/scan' && request.method === 'POST') {
        send(response, 200, await automation.runScan({
          queueCandidates: false,
          processQueued: false,
        }));
        return;
      }

      if (path === '/api/metadata/search' && request.method === 'GET') {
        const query = url.searchParams.get('q') || '';
        const mediaType = url.searchParams.get('mediaType') || 'tv';
        const requestedLimit = url.searchParams.has('limit')
          ? Number(url.searchParams.get('limit'))
          : 10;
        if (!query.trim()) throw httpError(400, 'q is required', 'invalid_query');
        if (query.trim().length > 200) {
          throw httpError(400, 'q must be 200 characters or fewer', 'invalid_query');
        }
        if (!['tv', 'movie'].includes(mediaType)) {
          throw httpError(400, 'mediaType must be tv or movie', 'invalid_media_type');
        }
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
          throw httpError(400, 'limit must be a positive integer', 'invalid_limit');
        }
        try {
          send(response, 200, await metadata.search(query, {
            mediaType,
            limit: Math.min(50, requestedLimit),
            context: { source: 'http-api' },
          }));
        } catch (error) {
          if (error?.code === 'ALL_PROVIDERS_FAILED') {
            throw httpError(502, 'all metadata providers failed', 'metadata_providers_failed');
          }
          throw error;
        }
        return;
      }

      if (path === '/api/shows' && request.method === 'GET') {
        send(response, 200, { items: await shows.list() });
        return;
      }

      if (path === '/api/shows' && request.method === 'POST') {
        const input = await readJson(request);
        const show = await shows.create(input);
        send(response, 201, { show });
        return;
      }

      const showMatch = path.match(/^\/api\/shows\/([^/]+)$/);
      if (showMatch && request.method === 'GET') {
        const id = positiveId(showMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        const show = await shows.getById(id);
        if (!show) throw httpError(404, 'show not found', 'show_not_found');
        send(response, 200, {
          show,
          metadataIdentities: await metadata.listIdentities(id),
        });
        return;
      }

      const identityMatch = path.match(/^\/api\/shows\/([^/]+)\/metadata-identities$/);
      if (identityMatch && request.method === 'GET') {
        const id = positiveId(identityMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        send(response, 200, { items: await metadata.listIdentities(id) });
        return;
      }
      if (identityMatch && request.method === 'POST') {
        const id = positiveId(identityMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        const input = await readJson(request);
        const identity = await metadata.linkIdentity({ ...input, showId: id });
        send(response, 201, { identity });
        return;
      }

      const showStoragesMatch = path.match(/^\/api\/shows\/([^/]+)\/storages$/);
      if (showStoragesMatch && request.method === 'GET') {
        const id = positiveId(showStoragesMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        if (!await shows.getById(id)) throw httpError(404, 'show not found', 'show_not_found');
        send(response, 200, { items: await episodes.listShowStorages(id) });
        return;
      }
      if (showStoragesMatch && request.method === 'POST') {
        const id = positiveId(showStoragesMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        if (!await shows.getById(id)) throw httpError(404, 'show not found', 'show_not_found');
        const input = await readJson(request);
        const providerId = String(input.providerId || '').trim();
        let rootPath = String(input.rootPath || '').trim();
        if (!/^[a-z][a-z0-9-]{1,63}$/.test(providerId)) {
          throw httpError(400, 'providerId is invalid', 'invalid_provider_id');
        }
        if (!rootPath) throw httpError(400, 'rootPath is required', 'invalid_root_path');
        if (providerId === 'local-storage') {
          const segments = rootPath.split('/').filter(Boolean);
          if (!rootPath.startsWith('/') || segments.length === 0
              || rootPath.includes('\\') || rootPath.includes('\u0000')
              || segments.some((segment) => segment === '.' || segment === '..')) {
            throw httpError(
              400,
              'local storage rootPath must be a non-root absolute POSIX path',
              'invalid_root_path',
            );
          }
          rootPath = '/' + segments.join('/');
        }
        if (input.enabled != null && typeof input.enabled !== 'boolean') {
          throw httpError(400, 'enabled must be a boolean', 'invalid_enabled');
        }
        const storageProvider = listPlugins({
          domain: 'storage',
          capability: 'listSharedFiles',
          enabledOnly: true,
        }).find((plugin) => plugin.id === providerId);
        if (!storageProvider) {
          throw httpError(422, 'storage provider is not enabled', 'storage_provider_unavailable');
        }
        const storage = await episodes.createStorage({
          showId: id,
          providerId,
          rootPath,
          enabled: input.enabled !== false,
        });
        send(response, 201, { storage });
        return;
      }

      const storageEpisodesMatch = path.match(/^\/api\/shows\/([^/]+)\/storages\/([^/]+)\/episodes$/);
      if (storageEpisodesMatch && request.method === 'GET') {
        const showId = positiveId(storageEpisodesMatch[1]);
        const storageId = positiveId(storageEpisodesMatch[2]);
        if (!showId) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        if (!storageId) throw httpError(400, 'storage id must be a positive integer', 'invalid_storage_id');
        if (!await shows.getById(showId)) throw httpError(404, 'show not found', 'show_not_found');
        const storages = await episodes.listShowStorages(showId);
        if (!storages.some((storage) => storage.id === storageId)) {
          throw httpError(404, 'storage not found for show', 'storage_not_found');
        }
        send(response, 200, { items: await episodes.listStorageEpisodes(storageId) });
        return;
      }

      const storageScanMatch = path.match(/^\/api\/shows\/([^/]+)\/storages\/([^/]+)\/scan$/);
      if (storageScanMatch && request.method === 'POST') {
        const showId = positiveId(storageScanMatch[1]);
        const storageId = positiveId(storageScanMatch[2]);
        if (!showId) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        if (!storageId) throw httpError(400, 'storage id must be a positive integer', 'invalid_storage_id');
        send(response, 200, await storageCatalog.scanStorage({ showId, storageId }));
        return;
      }

      const resourceSearchMatch = path.match(/^\/api\/shows\/([^/]+)\/resources\/search$/);
      if (resourceSearchMatch && request.method === 'POST') {
        const id = positiveId(resourceSearchMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        const input = await readJson(request);
        send(response, 200, await resourceDiscovery.searchForShow({ ...input, showId: id }));
        return;
      }

      const followupMatch = path.match(/^\/api\/shows\/([^/]+)\/followup\/(preview|queue)$/);
      if (followupMatch && request.method === 'POST') {
        const id = positiveId(followupMatch[1]);
        if (!id) throw httpError(400, 'show id must be a positive integer', 'invalid_show_id');
        const input = await readJson(request);
        if (followupMatch[2] === 'preview') {
          send(response, 200, {
            preview: await followup.previewShare({ ...input, showId: id }),
          });
          return;
        }
        const result = await followup.queueShare({ ...input, showId: id, source: 'manual' });
        send(response, result.queued ? 201 : result.event ? 409 : 200, {
          ...result,
          ...(result.event ? { event: publicEvent(result.event) } : {}),
        });
        return;
      }

      if (path === '/api/events' && request.method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        const limit = url.searchParams.get('limit') || undefined;
        send(response, 200, { items: (await events.list({ status, limit })).map(publicEvent) });
        return;
      }

      if (path === '/api/events' && request.method === 'POST') {
        const input = await readJson(request);
        if (input.kind === 'new_ep') {
          throw httpError(
            409,
            'episode follow-up events must be created through the follow-up queue',
            'followup_queue_required',
          );
        }
        send(response, 201, { event: publicEvent(await events.create(input)) });
        return;
      }

      const processMatch = path.match(/^\/api\/events\/([^/]+)\/process$/);
      if (processMatch && request.method === 'POST') {
        const id = positiveId(processMatch[1]);
        if (!id) throw httpError(400, 'event id must be a positive integer', 'invalid_event_id');
        const result = await followup.processEvent(id);
        send(response, 200, {
          ...result,
          event: publicEvent(result.event),
        });
        return;
      }

      const recoveryMatch = path.match(/^\/api\/events\/([^/]+)\/recover$/);
      if (recoveryMatch && request.method === 'POST') {
        const id = positiveId(recoveryMatch[1]);
        if (!id) throw httpError(400, 'event id must be a positive integer', 'invalid_event_id');
        const input = await readJson(request);
        const result = await followup.recoverInterruptedEvent(id, input);
        send(response, 200, {
          ...result,
          event: publicEvent(result.event),
        });
        return;
      }

      const eventMatch = path.match(/^\/api\/events\/([^/]+)\/transition$/);
      if (eventMatch && request.method === 'POST') {
        const id = positiveId(eventMatch[1]);
        if (!id) throw httpError(400, 'event id must be a positive integer', 'invalid_event_id');
        const current = await events.getById(id);
        if (!current) throw httpError(404, 'event not found', 'event_not_found');
        if (current.kind === 'new_ep') {
          throw httpError(
            409,
            'episode follow-up events must use the process or retry endpoint',
            'followup_process_required',
          );
        }
        const input = await readJson(request);
        send(response, 200, { event: publicEvent(await events.transition({ ...input, id })) });
        return;
      }

      const retryMatch = path.match(/^\/api\/events\/([^/]+)\/retry$/);
      if (retryMatch && request.method === 'POST') {
        const id = positiveId(retryMatch[1]);
        if (!id) throw httpError(400, 'event id must be a positive integer', 'invalid_event_id');
        send(response, 200, { event: publicEvent(await events.retryFailed(id)) });
        return;
      }

      send(response, 404, { error: 'not found', code: 'not_found' });
    } catch (error) {
      const message = String(error?.message || 'request failed');
      const providerFailures = publicProviderFailures(error);
      const status = Number.isInteger(error?.status) ? error.status
        : error instanceof TypeError ? 400
          : /not found|does not exist|not registered/i.test(message) ? 404
            : /cannot move|only failed|already has|linked to another|changed concurrently/i.test(message) ? 409
              : /does not provide|not enabled/i.test(message) ? 422
                : error?.code === 'SIDECAR_WRITE_UNSUPPORTED' ? 422
                : 500;
      send(response, status, {
        error: status >= 500 ? 'request failed' : message,
        code: error?.code || (status >= 500 ? 'internal_error' : 'request_failed'),
        ...(providerFailures ? { providers: providerFailures } : {}),
      });
    }
  };
}

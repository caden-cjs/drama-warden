import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function safeErrorCode(value) {
  const code = String(value || 'MCP_REQUEST_FAILED');
  return /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'MCP_REQUEST_FAILED';
}

function requiredEnvironmentValue(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(field + ' is required');
  return normalized;
}

const enabled = ['1', 'true'].includes(
  String(process.env.ENABLE_MCP || '').trim().toLowerCase(),
);
if (!enabled) {
  process.stderr.write('MCP bridge is disabled; set ENABLE_MCP=true to run it.\n');
  process.exitCode = 1;
} else {
  const token = requiredEnvironmentValue(process.env.API_ACCESS_TOKEN, 'API_ACCESS_TOKEN');
  const apiBase = new URL(process.env.DRAMA_WARDEN_API_URL || 'http://127.0.0.1:8080');
  if (!['http:', 'https:'].includes(apiBase.protocol) || apiBase.username || apiBase.password) {
    throw new TypeError('DRAMA_WARDEN_API_URL must be an HTTP(S) URL without embedded credentials');
  }

  async function requestApi(path, { method = 'GET', body } = {}) {
    const url = new URL(path, apiBase);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      const error = new Error('API request failed');
      error.status = response.status;
      error.code = safeErrorCode(payload.code);
      if (Array.isArray(payload.providers)) error.providers = payload.providers;
      throw error;
    }
    return payload;
  }

  function toolResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }

  function toolError(error) {
    const result = {
      error: 'Drama Warden API request failed',
      code: safeErrorCode(error?.code),
    };
    if (Array.isArray(error?.providers)) {
      result.providers = error.providers.map((provider) => ({
        providerId: String(provider?.providerId || 'unknown'),
        errorCode: safeErrorCode(provider?.errorCode),
      }));
    }
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }

  const mcpServer = new McpServer({ name: 'drama-warden', version: '0.1.0' });

  function registerApiTool(name, description, inputSchema, handler) {
    mcpServer.registerTool(name, { description, inputSchema }, async (input) => {
      try {
        return toolResult(await handler(input));
      } catch (error) {
        return toolError(error);
      }
    });
  }

  registerApiTool(
    'list_shows',
    'List tracked TV shows in Drama Warden.',
    {},
    () => requestApi('/api/shows'),
  );
  registerApiTool(
    'get_show',
    'Read one tracked show and its linked metadata identities.',
    { showId: z.number().int().positive() },
    ({ showId }) => requestApi('/api/shows/' + showId),
  );
  registerApiTool(
    'search_metadata',
    'Search metadata providers for TV show or movie candidates. This does not link a candidate.',
    {
      query: z.string().trim().min(1).max(200),
      mediaType: z.enum(['tv', 'movie']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    ({ query, mediaType, limit }) => {
      const search = new URLSearchParams({ q: query });
      if (mediaType) search.set('mediaType', mediaType);
      if (limit) search.set('limit', String(limit));
      return requestApi('/api/metadata/search?' + search.toString());
    },
  );
  registerApiTool(
    'search_resources',
    'Search configured resource providers and preview candidate shares without queueing or saving media.',
    {
      showId: z.number().int().positive(),
      storageId: z.number().int().positive(),
      query: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    ({ showId, ...body }) => requestApi('/api/shows/' + showId + '/resources/search', {
      method: 'POST',
      body,
    }),
  );
  registerApiTool(
    'preview_followup',
    'Preview a share against metadata and stored episodes. This does not save media.',
    {
      showId: z.number().int().positive(),
      storageId: z.number().int().positive(),
      shareUrl: z.string().trim().min(1).max(4096),
      shareTitle: z.string().max(500).optional(),
    },
    ({ showId, ...body }) => requestApi('/api/shows/' + showId + '/followup/preview', {
      method: 'POST',
      body,
    }),
  );
  registerApiTool(
    'queue_followup',
    'Queue the confirmed missing files from a share. This creates an event and reserves episode write claims; it does not save media.',
    {
      showId: z.number().int().positive(),
      storageId: z.number().int().positive(),
      shareUrl: z.string().trim().min(1).max(4096),
      shareTitle: z.string().max(500).optional(),
    },
    ({ showId, ...body }) => requestApi('/api/shows/' + showId + '/followup/queue', {
      method: 'POST',
      body,
    }),
  );
  registerApiTool(
    'list_events',
    'List follow-up events, optionally filtered by status.',
    {
      status: z.enum(['pending', 'processing', 'processed', 'skipped', 'failed']).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    ({ status, limit }) => {
      const search = new URLSearchParams();
      if (status) search.set('status', status);
      if (limit) search.set('limit', String(limit));
      return requestApi('/api/events' + (search.size ? '?' + search.toString() : ''));
    },
  );
  registerApiTool(
    'retry_event',
    'Retry a failed event only when it has no storage write claims; uncertain writes remain blocked for manual review.',
    { eventId: z.number().int().positive() },
    ({ eventId }) => requestApi('/api/events/' + eventId + '/retry', { method: 'POST' }),
  );
  registerApiTool(
    'process_event',
    'Process one pending follow-up event. This writes selected media through the configured storage provider; failures after a save attempt require destination inspection.',
    { eventId: z.number().int().positive() },
    ({ eventId }) => requestApi('/api/events/' + eventId + '/process', { method: 'POST' }),
  );
  registerApiTool(
    'automation_status',
    'Read periodic follow-up scheduler settings and the latest in-memory scan summary.',
    {},
    () => requestApi('/api/automation/status'),
  );
  registerApiTool(
    'scan_automation',
    'Run a one-shot candidate preview across tracked shows. It does not queue events or save media.',
    {},
    () => requestApi('/api/automation/scan', { method: 'POST' }),
  );

  await mcpServer.connect(new StdioServerTransport());
}

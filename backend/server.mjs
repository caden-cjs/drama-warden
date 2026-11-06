import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/index.mjs';
import { createShowRepository } from './core/show-repository.mjs';
import { createEpisodeRepository } from './core/episode-repository.mjs';
import { createEventRepository } from './core/event-repository.mjs';
import { createPluginCallRepository } from './core/plugin-call-repository.mjs';
import { createMetadataService } from './core/metadata-service.mjs';
import { createFollowupService } from './core/followup-service.mjs';
import { createResourceDiscoveryService } from './core/resource-discovery-service.mjs';
import {
  createFollowupAutomationService,
  createFollowupScheduler,
} from './core/followup-automation.mjs';
import { createStorageCatalogService } from './core/storage-catalog-service.mjs';
import { createSubtitleRepository } from './core/subtitle-repository.mjs';
import { createSubtitleService } from './core/subtitle-service.mjs';
import { createSubtitleWorker } from './core/subtitle-worker.mjs';
import { createRuntimeSettings } from './core/runtime-settings.mjs';
import { createPluginSettings } from './core/plugin-settings.mjs';
import { createPluginRuntime } from './plugins/runtime.mjs';
import { createLocalStoragePlugin } from './plugins/local-storage/index.mjs';
import { createLocalResourcePlugin } from './plugins/local-resource/index.mjs';
import { createTvmazePlugin } from './plugins/metadata/tvmaze.mjs';
import { createTmdbPlugin } from './plugins/metadata/tmdb.mjs';
import { createFeishuNotificationPlugin } from './plugins/notification/feishu.mjs';
import { createQuarkStoragePlugin } from './plugins/quark/index.mjs';
import { createPan115StoragePlugin } from './plugins/pan115/index.mjs';
import { createSmartstrmIndexerPlugin } from './plugins/indexer/smartstrm.mjs';
import { createAssrtPlugin } from './plugins/subtitle/assrt.mjs';
import { createOpenSubtitlesPlugin } from './plugins/subtitle/opensubtitles.mjs';
import { createApiHandler } from './api/http.mjs';
import { createStaticHandler } from './api/static.mjs';

const port = Number(process.env.PORT || 8080);
const builtins = [];
if (String(process.env.TMDB_API_KEY || '').trim()) {
  builtins.push(createTmdbPlugin({ apiKey: process.env.TMDB_API_KEY }));
}
builtins.push(createTvmazePlugin());
if (String(process.env.FEISHU_WEBHOOK_URL || '').trim()) {
  builtins.push(createFeishuNotificationPlugin({
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    webhookSecret: process.env.FEISHU_WEBHOOK_SECRET,
  }));
}
if (String(process.env.QUARK_CLI_PATH || '').trim()) {
  builtins.push(createQuarkStoragePlugin());
}
if (String(process.env.PAN115_CLI_PATH || '').trim()) {
  builtins.push(createPan115StoragePlugin());
}
const smartstrmSettings = [
  process.env.SMARTSTRM_BASE_URL,
  process.env.SMARTSTRM_WEBHOOK_TOKEN,
  process.env.SMARTSTRM_TASK_NAME,
].map((value) => String(value || '').trim());
if (smartstrmSettings.every(Boolean)) {
  builtins.push(createSmartstrmIndexerPlugin());
} else if (smartstrmSettings.some(Boolean)) {
  process.stderr.write('SmartStrm indexer disabled: configure SMARTSTRM_BASE_URL, SMARTSTRM_WEBHOOK_TOKEN, and SMARTSTRM_TASK_NAME together\n');
}
if (String(process.env.LOCAL_STORAGE_ENABLED || '').toLowerCase() === 'true') {
  builtins.push(createLocalStoragePlugin({
    storageRoot: process.env.LOCAL_STORAGE_ROOT || '/app/data/media',
    shareRoot: process.env.LOCAL_STORAGE_SHARE_ROOT || '/local-shares',
  }));
  builtins.push(createLocalResourcePlugin({
    shareRoot: process.env.LOCAL_STORAGE_SHARE_ROOT || '/local-shares',
  }));
}
if (String(process.env.SUBTITLE_ASSRT_ENABLED || '').toLowerCase() === 'true') {
  builtins.push(createAssrtPlugin());
}
if (String(process.env.OPENSUBTITLES_API_KEY || '').trim()) {
  builtins.push(createOpenSubtitlesPlugin());
}
const db = await openDatabase();
const pluginCalls = createPluginCallRepository(db);
let pluginRuntime;
try {
  await pluginCalls.initialize();
  pluginRuntime = await createPluginRuntime({
    builtins,
    context: { logger: console },
    logger: console,
    onCall: pluginCalls.record,
    initialize: false,
  });
} catch (error) {
  await db.close();
  throw error;
}
const pluginSettings = createPluginSettings({
  db,
  host: pluginRuntime.host,
  context: { logger: console },
});
await pluginSettings.initialize();
await pluginRuntime.initializePlugins();
const shows = createShowRepository(db);
const episodes = createEpisodeRepository(db);
const events = createEventRepository(db);
const subtitleRepository = createSubtitleRepository(db);
const metadata = createMetadataService({
  shows,
  catalog: episodes,
  listProviders: ({ enabledOnly = true } = {}) => pluginRuntime.host.listPlugins({
    domain: 'metadata',
    enabledOnly,
  }),
  invoke: pluginRuntime.host.invoke,
});
const storageCatalog = createStorageCatalogService({
  shows,
  episodes,
  listPlugins: pluginRuntime.host.listPlugins,
  invoke: pluginRuntime.host.invoke,
});
const followup = createFollowupService({
  shows,
  episodes,
  events,
  metadata,
  listPlugins: pluginRuntime.host.listPlugins,
  invoke: pluginRuntime.host.invoke,
  publishEvent: pluginRuntime.host.publishEvent,
});
const resourceDiscovery = createResourceDiscoveryService({
  shows,
  episodes,
  listPlugins: pluginRuntime.host.listPlugins,
  invoke: pluginRuntime.host.invoke,
  followup,
});
const automation = createFollowupAutomationService({
  shows,
  episodes,
  events,
  resourceDiscovery,
  followup,
});
const subtitles = createSubtitleService({
  shows,
  episodes,
  repository: subtitleRepository,
  listPlugins: pluginRuntime.host.listPlugins,
  pluginCalls,
});
const subtitleWorkerEnabled = String(process.env.SUBTITLE_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
const subtitleWorker = createSubtitleWorker({
  repository: subtitleRepository,
  listPlugins: pluginRuntime.host.listPlugins,
  invoke: pluginRuntime.host.invoke,
  logger: console,
});
const runtimeSettings = createRuntimeSettings({ db });
const configuredRuntime = await runtimeSettings.get();
const scheduler = createFollowupScheduler({
  enabled: configuredRuntime.settings.followupAutomationEnabled,
  intervalMinutes: configuredRuntime.settings.followupScanIntervalMinutes,
  autoProcess: configuredRuntime.settings.followupAutoProcess,
  automation,
  logger: console,
});
const apiHandler = createApiHandler({
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
  runtimeSettings,
  pluginSettings,
  pluginCalls,
  listPlugins: pluginRuntime.host.listPlugins,
});
const staticHandler = createStaticHandler({
  root: process.env.FRONTEND_DIST || fileURLToPath(new URL('../frontend/dist', import.meta.url)),
});

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    let databaseReady = false;
    try {
      const row = await db.get('SELECT 1 AS ready');
      databaseReady = Number(row?.ready) === 1;
    } catch {
      databaseReady = false;
    }
    response.writeHead(databaseReady ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({
      status: databaseReady ? 'ok' : 'degraded',
      database: databaseReady ? 'ok' : 'unavailable',
      service: 'drama-warden',
      plugins: pluginRuntime.host.listPlugins({ enabledOnly: false }).length,
    }));
    return;
  }

  if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
    await apiHandler(request, response);
    return;
  }

  await staticHandler(request, response, requestUrl);
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write('drama-warden listening on ' + port + '\n');
  scheduler.start();
  if (subtitleWorkerEnabled) subtitleWorker.start();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  subtitleWorker.stop();
  server.close(() => {
    Promise.all([scheduler.waitForIdle(), subtitleWorker.waitForIdle()])
      .then(() => db.close()).catch((error) => {
      process.stderr.write('database close failed: ' + String(error?.message || error) + '\n');
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

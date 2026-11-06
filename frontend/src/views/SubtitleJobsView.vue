<script setup>
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import { errorMessage, formatDate, providerTitle } from '../lib/format.js';

const api = inject('api');
const notify = inject('notify');
const jobs = ref([]);
const shows = ref([]);
const plugins = ref([]);
const worker = ref({ enabled: false, processing: false, intervalMs: 0 });
const subtitleProviders = ref([]);
const loading = ref(true);
const refreshing = ref(false);
const hasLoaded = ref(false);
const loadError = ref('');
const query = ref('');
const statusFilter = ref('all');
const showFilter = ref('all');
const selectedJob = ref(null);
const detailsLoading = ref(false);
const retryingId = ref(null);
const showQueue = ref(false);
const queueLoading = ref(false);
const queueing = ref(false);
const queueError = ref('');
const queueStorages = ref([]);
const queueEpisodes = ref([]);
const queueForm = ref({ showId: '', storageId: '', episodeKey: '', languages: ['zh-CN', 'zh-TW'] });
let refreshTimer;

const showById = computed(() => new Map(shows.value.map((show) => [show.id, show])));
const pluginById = computed(() => new Map(plugins.value.map((plugin) => [plugin.id, plugin])));
const writeSidecarPlugins = computed(() => plugins.value.filter((plugin) =>
  plugin.enabled && plugin.kind === 'storage-provider' && plugin.capabilities?.includes('writeSidecar')));
const supportedProviders = computed(() => subtitleProviders.value
  .map((provider) => provider.label || provider.id));
const statusOptions = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '等待中' },
  { id: 'processing', label: '处理中' },
  { id: 'completed', label: '已完成' },
  { id: 'skipped', label: '已跳过' },
  { id: 'failed', label: '失败' },
  { id: 'uncertain', label: '需核对' },
];
const counts = computed(() => Object.fromEntries([
  'pending', 'processing', 'completed', 'skipped', 'failed', 'uncertain',
].map((status) => [status, jobs.value.filter((job) => job.status === status).length])));
const filteredJobs = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return jobs.value.filter((job) => {
    if (statusFilter.value !== 'all' && job.status !== statusFilter.value) return false;
    if (showFilter.value !== 'all' && job.showId !== Number(showFilter.value)) return false;
    const showName = job.showName || showById.value.get(job.showId)?.name || '';
    const storageName = pluginById.value.get(job.storageProviderId)?.label || job.storageProviderId || '';
    const text = [showName, storageName, job.seasonNumber, job.episodeNumber,
      job.providerId, job.errorCode, job.outputPath, job.id].filter(Boolean).join(' ').toLowerCase();
    return !needle || text.includes(needle);
  });
});
const queueShows = computed(() => shows.value.filter((show) => show.mediaType === 'tv'));
const supportedQueueStorages = computed(() => queueStorages.value.filter((storage) =>
  storage.enabled && writeSidecarPlugins.value.some((plugin) => plugin.id === storage.providerId)));
const queueEligibleEpisodes = computed(() => queueEpisodes.value.filter((episode) =>
  episode.status === 'present' && episode.assetCount === 1
  && !jobs.value.some((job) => job.storageId === Number(queueForm.value.storageId)
    && job.seasonNumber === episode.seasonNumber
    && job.episodeNumber === episode.episodeNumber)));
const queuedEpisodeCount = computed(() => queueEpisodes.value.filter((episode) =>
  jobs.value.some((job) => job.storageId === Number(queueForm.value.storageId)
    && job.seasonNumber === episode.seasonNumber && job.episodeNumber === episode.episodeNumber)).length);
const conflictEpisodeCount = computed(() => queueEpisodes.value.filter((episode) =>
  episode.status === 'conflict' || episode.assetCount > 1).length);
const selectedQueueEpisode = computed(() => queueEligibleEpisodes.value.find((episode) =>
  `${episode.seasonNumber}:${episode.episodeNumber}` === queueForm.value.episodeKey) || null);
const queueCanSubmit = computed(() => Boolean(
  queueForm.value.showId && queueForm.value.storageId && selectedQueueEpisode.value
      && queueForm.value.languages.length && subtitleProviders.value.length && !queueLoading.value,
));

function statusLabel(status) {
  return ({
    pending: '等待中',
    processing: '处理中',
    completed: '已完成',
    skipped: '已跳过',
    failed: '失败',
    uncertain: '需核对',
  })[status] || status || '未知';
}

function jobTitle(job) {
  return job.showName || showById.value.get(job.showId)?.name || `节目 #${job.showId}`;
}

function storageTitle(job) {
  const plugin = pluginById.value.get(job.storageProviderId);
  return plugin ? providerTitle(plugin) : (job.storageProviderId || `位置 #${job.storageId}`);
}

function languageLabel(language) {
  return ({ 'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英语' })[language] || language;
}

function episodeLabel(episode) {
  return `S${String(episode.seasonNumber).padStart(2, '0')} · 第 ${episode.episodeNumber} 集`;
}

async function load({ quiet = false } = {}) {
  if (refreshing.value) return;
  refreshing.value = true;
  if (!hasLoaded.value) loading.value = true;
  try {
    const [jobResponse, statusResponse, showResponse, pluginResponse] = await Promise.all([
      api.request('/api/subtitle-jobs?limit=500'),
      api.request('/api/subtitles/status'),
      api.request('/api/shows'),
      api.request('/api/plugins'),
    ]);
    jobs.value = jobResponse.items || [];
    worker.value = statusResponse.worker || worker.value;
    subtitleProviders.value = statusResponse.providers || [];
    shows.value = showResponse.items || [];
    plugins.value = pluginResponse.items || [];
    loadError.value = '';
    hasLoaded.value = true;
  } catch (error) {
    loadError.value = errorMessage(error);
    if (!quiet) notify(loadError.value, 'error');
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function openQueue() {
  queueError.value = '';
  queueStorages.value = [];
  queueEpisodes.value = [];
  queueForm.value = { showId: '', storageId: '', episodeKey: '', languages: ['zh-CN', 'zh-TW'] };
  showQueue.value = true;
}

async function selectQueueShow() {
  queueError.value = '';
  queueForm.value.storageId = '';
  queueForm.value.episodeKey = '';
  queueStorages.value = [];
  queueEpisodes.value = [];
  const showId = Number(queueForm.value.showId);
  if (!showId) return;
  queueLoading.value = true;
  try {
    const response = await api.request(`/api/shows/${showId}/storages`);
    queueStorages.value = response.items || [];
    const first = supportedQueueStorages.value[0];
    if (first) {
      queueForm.value.storageId = String(first.id);
      await loadQueueEpisodes(first.id);
    }
  } catch (error) {
    queueError.value = errorMessage(error);
  } finally {
    queueLoading.value = false;
  }
}

async function loadQueueEpisodes(storageId) {
  queueError.value = '';
  queueForm.value.episodeKey = '';
  queueEpisodes.value = [];
  if (!storageId || !queueForm.value.showId) return;
  queueLoading.value = true;
  try {
    const response = await api.request(
      `/api/shows/${Number(queueForm.value.showId)}/storages/${Number(storageId)}/episodes`,
    );
    queueEpisodes.value = response.items || [];
    const first = queueEligibleEpisodes.value[0];
    if (first) queueForm.value.episodeKey = `${first.seasonNumber}:${first.episodeNumber}`;
  } catch (error) {
    queueError.value = errorMessage(error);
  } finally {
    queueLoading.value = false;
  }
}

async function selectQueueStorage() {
  await loadQueueEpisodes(Number(queueForm.value.storageId));
}

async function queueSubtitle() {
  const episode = selectedQueueEpisode.value;
  if (!episode || !queueCanSubmit.value) return;
  queueing.value = true;
  try {
    const response = await api.request(`/api/shows/${Number(queueForm.value.showId)}/subtitle-jobs`, {
      method: 'POST',
      body: {
        storageId: Number(queueForm.value.storageId),
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        languages: queueForm.value.languages,
      },
    });
    notify(response.queued ? '任务当前处于等待处理状态。' : `此集已有字幕任务（${statusLabel(response.job?.status)}）。`,
      response.queued ? 'success' : 'info');
    showQueue.value = false;
    await load({ quiet: true });
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    queueing.value = false;
  }
}

async function openDetails(job) {
  selectedJob.value = job;
  detailsLoading.value = true;
  try {
    const response = await api.request(`/api/subtitle-jobs/${job.id}`);
    selectedJob.value = { ...job, ...(response.job || {}) };
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    detailsLoading.value = false;
  }
}

async function retryJob(job) {
  if (!job?.retryable || retryingId.value != null) return;
  retryingId.value = job.id;
  try {
    const response = await api.request(`/api/subtitle-jobs/${job.id}/retry`, { method: 'POST' });
    selectedJob.value = response.job ? { ...selectedJob.value, ...response.job } : selectedJob.value;
    notify('字幕任务已安全重试。');
    await load({ quiet: true });
  } catch (error) {
    notify(errorMessage(error), 'error');
    await load({ quiet: true });
  } finally {
    retryingId.value = null;
  }
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(() => load({ quiet: true }), 15000);
});

onUnmounted(() => window.clearInterval(refreshTimer));
</script>

<template>
  <div class="view-stack">
    <div class="page-intro">
      <div><h2>为已归档的视频补充旁路字幕。</h2><p>根据媒体库当前记录的唯一视频集排队；worker 写入前还会重新核对完整目录。</p></div>
      <div class="subtitle-page-actions">
        <button class="button button-secondary" type="button" :disabled="refreshing" @click="load()"><span class="button-icon">⟳</span>{{ refreshing ? '正在刷新' : '刷新任务' }}</button>
        <button class="button button-primary" type="button" @click="openQueue"><span>＋</span>添加字幕任务</button>
      </div>
    </div>

    <div class="metric-grid subtitle-metrics">
      <article class="metric-card"><div class="metric-top"><span>等待处理</span><span class="metric-icon amber">◷</span></div><div class="metric-value">{{ counts.pending || 0 }}<small> 项</small></div><div class="metric-foot">worker 会按队列自动处理</div></article>
      <article class="metric-card"><div class="metric-top"><span>正在处理</span><span class="metric-icon blue">↻</span></div><div class="metric-value">{{ counts.processing || 0 }}<small> 项</small></div><div class="metric-foot">持久化任务可在重启后恢复</div></article>
      <article class="metric-card"><div class="metric-top"><span>已完成</span><span class="metric-icon mint">✓</span></div><div class="metric-value">{{ counts.completed || 0 }}<small> 项</small></div><div class="metric-foot">字幕已写入视频旁路文件</div></article>
      <article class="metric-card"><div class="metric-top"><span>需要关注</span><span class="metric-icon lilac">!</span></div><div class="metric-value">{{ (counts.failed || 0) + (counts.uncertain || 0) }}<small> 项</small></div><div class="metric-foot">{{ counts.failed || 0 }} 项可安全重试 · {{ counts.uncertain || 0 }} 项需先核对</div></article>
    </div>

    <section class="panel subtitle-worker-card">
      <span class="automation-light" :class="{ enabled: worker.enabled }"></span>
      <div><strong>字幕 worker {{ worker.enabled ? '已启用' : '已停用' }}</strong><small>字幕提供方：{{ supportedProviders.length ? supportedProviders.join(' · ') : '未启用' }}<template v-if="worker.intervalMs"> · 检查间隔 {{ Math.round(worker.intervalMs / 1000) }} 秒</template></small></div>
      <span v-if="worker.processing" class="status-chip chip-processing">任务执行中</span>
      <span v-else class="status-chip" :class="worker.enabled ? 'chip-processed' : 'chip-muted'">{{ worker.enabled ? '运行中' : '已暂停' }}</span>
    </section>

    <div v-if="loadError && hasLoaded" class="inline-alert error-alert"><span class="alert-symbol">!</span><div><strong>任务列表未能刷新</strong><p>{{ loadError }} 当前仍显示上次成功加载的数据。</p><button class="text-button" type="button" :disabled="refreshing" @click="load()">重试 <span>→</span></button></div></div>
    <div v-else-if="loadError && !hasLoaded" class="inline-alert error-alert"><span class="alert-symbol">!</span><div><strong>字幕任务服务不可用</strong><p>{{ loadError }}</p><button class="text-button" type="button" :disabled="refreshing" @click="load()">重试 <span>→</span></button></div></div>

    <section class="panel toolbar-panel subtitle-toolbar">
      <div class="search-field"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索节目、集数、提供方或错误码" /></div>
      <label class="subtitle-show-filter"><span class="sr-only">按节目筛选</span><select v-model="showFilter"><option value="all">所有节目</option><option v-for="show in shows" :key="show.id" :value="String(show.id)">{{ show.name }}</option></select></label>
      <div class="filter-tabs subtitle-status-filter"><button v-for="option in statusOptions" :key="option.id" type="button" :class="{ selected: statusFilter === option.id }" @click="statusFilter = option.id">{{ option.label }}<small v-if="option.id !== 'all'">{{ counts[option.id] || 0 }}</small></button></div>
    </section>

    <section class="panel subtitle-table-panel">
      <div class="subtitle-table-heading"><span>节目 / 集数</span><span>存储位置</span><span>任务状态</span><span>语言 / 提供方</span><span>最近更新</span><span></span></div>
      <div v-if="loading" class="table-loading"><div v-for="index in 5" :key="index" class="skeleton-line"></div></div>
      <div v-else-if="!hasLoaded && loadError" class="empty-state compact-empty"><div class="empty-illustration">!</div><strong>无法加载字幕任务</strong><p>{{ loadError }}</p></div>
      <div v-else-if="!filteredJobs.length" class="empty-state compact-empty"><div class="empty-illustration">▤</div><strong>{{ jobs.length ? '没有符合条件的任务' : '还没有字幕任务' }}</strong><p>{{ jobs.length ? '调整筛选条件，或为已扫描的唯一视频集添加任务。' : '添加任务后，worker 会搜索可用字幕并安全写入视频旁路文件。' }}</p><button v-if="!jobs.length" class="button button-primary" type="button" @click="openQueue">添加第一个任务</button></div>
      <div v-else class="subtitle-job-list">
        <article v-for="job in filteredJobs" :key="job.id" class="subtitle-job-row">
          <button class="subtitle-job-main" type="button" @click="openDetails(job)">
            <span class="subtitle-job-mark" :class="`job-${job.status}`">{{ job.status === 'completed' ? '✓' : job.status === 'uncertain' ? '!' : 'S' }}</span>
            <span class="subtitle-job-copy"><strong>{{ jobTitle(job) }}</strong><small>S{{ String(job.seasonNumber).padStart(2, '0') }}E{{ String(job.episodeNumber).padStart(2, '0') }} · 任务 #{{ job.id }}</small></span>
          </button>
          <span class="subtitle-job-storage">{{ storageTitle(job) }}</span>
          <span><span class="status-chip" :class="`chip-${job.status}`">{{ statusLabel(job.status) }}</span><small v-if="job.errorCode" class="subtitle-error-code">{{ job.errorCode }}</small></span>
          <span class="subtitle-job-languages"><strong>{{ (job.languages || []).map(languageLabel).join('、') || '—' }}</strong><small>{{ pluginById.get(job.providerId)?.label || job.providerId || '等待提供方' }}</small></span>
          <span class="subtitle-job-time">{{ formatDate(job.updatedAt) }}</span>
          <span class="subtitle-job-actions"><button v-if="job.status === 'failed' && job.retryable" class="button button-secondary button-small" type="button" :disabled="retryingId === job.id" @click="retryJob(job)">{{ retryingId === job.id ? '重试中…' : '安全重试' }}</button><button v-else class="icon-button small" type="button" :aria-label="`查看字幕任务 ${job.id} 详情`" @click="openDetails(job)">›</button></span>
        </article>
      </div>
      <div class="table-footer">显示最近 {{ jobs.length }} / 最多 500 项字幕任务。任务状态每 15 秒刷新一次。需核对任务不会提供重试入口。</div>
    </section>

    <Teleport to="body">
      <div v-if="showQueue" class="modal-backdrop" @click.self="showQueue = false">
        <section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="subtitle-queue-title">
          <div class="modal-heading"><div><span class="modal-kicker">字幕任务 / 新建</span><h2 id="subtitle-queue-title">添加单集字幕任务</h2><p>仅显示媒体库当前记录为唯一视频版本的集数；worker 会在写入前重新核对。</p></div><button class="icon-button" type="button" aria-label="关闭" @click="showQueue = false">×</button></div>
          <div class="form-stack">
            <label class="field"><span>节目</span><select v-model="queueForm.showId" @change="selectQueueShow"><option value="">选择一部剧集</option><option v-for="show in queueShows" :key="show.id" :value="String(show.id)">{{ show.name }}</option></select><small>字幕任务目前面向电视剧集；电影尚无 canonical 集数目录。</small></label>
            <label class="field"><span>媒体库位置</span><select v-model="queueForm.storageId" :disabled="!queueForm.showId || queueLoading" @change="selectQueueStorage"><option value="">选择支持旁路字幕写入的位置</option><option v-for="storage in supportedQueueStorages" :key="storage.id" :value="String(storage.id)">{{ providerTitle(pluginById.get(storage.providerId)) }} · 位置 #{{ storage.id }}</option></select><small>只有启用 `writeSidecar` 能力的存储插件会显示。当前夸克和 115 不支持字幕写入。</small></label>
            <label class="field"><span>季 / 集</span><select v-model="queueForm.episodeKey" :disabled="!queueEligibleEpisodes.length || queueLoading"><option value="">{{ queueLoading ? '正在读取媒体库集数…' : '选择季和集数' }}</option><option v-for="episode in queueEligibleEpisodes" :key="`${episode.seasonNumber}:${episode.episodeNumber}`" :value="`${episode.seasonNumber}:${episode.episodeNumber}`">{{ episodeLabel(episode) }}</option></select><small v-if="queueEpisodes.length">媒体库记录 {{ queueEpisodes.filter((episode) => episode.status === 'present' && episode.assetCount === 1).length }} 个唯一视频集；{{ queuedEpisodeCount }} 集已有任务；{{ conflictEpisodeCount }} 集存在多个视频版本。任务执行前会重新读取完整目录；若清单不完整或资产有变化，不会开始字幕写入。</small><small v-else>请先在节目详情中扫描所选媒体库位置。</small></label>
            <fieldset class="subtitle-language-field"><legend>字幕语言</legend><label><input v-model="queueForm.languages" type="checkbox" value="zh-CN" /> 简体中文</label><label><input v-model="queueForm.languages" type="checkbox" value="zh-TW" /> 繁体中文</label><label><input v-model="queueForm.languages" type="checkbox" value="en" /> 英语</label></fieldset>
            <div v-if="queueError" class="inline-alert error-alert"><span class="alert-symbol">!</span><div><strong>无法读取可选目标</strong><p>{{ queueError }}</p></div></div>
            <div v-if="!subtitleProviders.length" class="inline-alert warning-alert"><span class="alert-symbol">!</span><div><strong>没有启用的字幕提供方</strong><p>先在服务端配置 OpenSubtitles API key，或启用 Assrt provider，再创建任务。</p></div></div>
            <div v-else-if="!worker.enabled" class="inline-alert warning-alert"><span class="alert-symbol">!</span><div><strong>字幕 worker 已停用</strong><p>任务可以排队，但 worker 不会处理，直到服务端重新启用字幕 worker。</p></div></div>
            <div class="helper-panel">任务只会写入匹配视频旁边的新字幕文件。若写入状态不确定，系统会暂停任务以供人工核对，不会自动覆盖或重试。</div>
            <div class="modal-actions"><button class="button button-quiet" type="button" :disabled="queueing" @click="showQueue = false">取消</button><button class="button button-primary" type="button" :disabled="!queueCanSubmit || queueing" @click="queueSubtitle">{{ queueing ? '正在排队…' : '加入任务队列' }}</button></div>
          </div>
        </section>
      </div>

      <div v-if="selectedJob" class="modal-backdrop" @click.self="selectedJob = null">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="subtitle-job-detail-title">
          <div class="modal-heading"><div><span class="modal-kicker">字幕任务 / #{{ selectedJob.id }}</span><h2 id="subtitle-job-detail-title">{{ jobTitle(selectedJob) }}</h2><p>S{{ String(selectedJob.seasonNumber).padStart(2, '0') }}E{{ String(selectedJob.episodeNumber).padStart(2, '0') }} · {{ storageTitle(selectedJob) }}</p></div><button class="icon-button" type="button" aria-label="关闭" @click="selectedJob = null">×</button></div>
          <div v-if="detailsLoading" class="loading-modal"><span class="spinner"></span>正在读取任务详情…</div>
          <template v-else>
            <div class="event-detail-facts">
              <div><span>状态</span><strong><span class="status-chip" :class="`chip-${selectedJob.status}`">{{ statusLabel(selectedJob.status) }}</span></strong></div>
              <div><span>尝试次数</span><strong>{{ selectedJob.attemptCount }}</strong></div>
              <div><span>目标语言</span><strong>{{ (selectedJob.languages || []).map(languageLabel).join('、') || '—' }}</strong></div>
              <div><span>字幕提供方</span><strong>{{ pluginById.get(selectedJob.providerId)?.label || selectedJob.providerId || '尚未选择' }}</strong></div>
              <div><span>创建时间</span><strong>{{ formatDate(selectedJob.createdAt) }}</strong></div>
              <div><span>最近更新</span><strong>{{ formatDate(selectedJob.updatedAt) }}</strong></div>
            </div>
            <div v-if="selectedJob.nextAttemptAt && selectedJob.status === 'pending'" class="helper-panel">下次尝试时间：{{ formatDate(selectedJob.nextAttemptAt) }}</div>
            <div v-if="selectedJob.outputPath" class="helper-panel subtitle-output-path"><strong>写入路径</strong><span>{{ selectedJob.outputPath }}</span></div>
            <div v-if="selectedJob.errorCode" class="inline-alert" :class="selectedJob.status === 'uncertain' ? 'warning-alert' : 'error-alert'"><span class="alert-symbol">!</span><div><strong>{{ selectedJob.status === 'uncertain' ? '写入结果需要人工核对' : '任务错误代码' }}</strong><p>{{ selectedJob.errorCode }}<template v-if="selectedJob.status === 'uncertain'">。请先检查目标目录中是否已生成字幕文件；确认前不要重复写入。</template></p></div></div>
            <div class="modal-actions"><button class="button button-quiet" type="button" @click="selectedJob = null">关闭</button><button v-if="selectedJob.status === 'failed' && selectedJob.retryable" class="button button-secondary" type="button" :disabled="retryingId === selectedJob.id" @click="retryJob(selectedJob)">{{ retryingId === selectedJob.id ? '正在重试…' : '安全重试' }}</button></div>
          </template>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.subtitle-page-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.subtitle-worker-card { display: flex; align-items: center; gap: 11px; padding: 13px 16px; }
.subtitle-worker-card > div { min-width: 0; flex: 1; }
.subtitle-worker-card strong, .subtitle-worker-card small { display: block; }
.subtitle-worker-card strong { color: #46536a; font-size: 10px; }
.subtitle-worker-card small { margin-top: 4px; color: #9aa4b3; font-size: 9px; }
.subtitle-metrics .metric-card { min-height: 137px; }
.subtitle-toolbar { flex-wrap: wrap; }
.subtitle-toolbar .search-field { flex: 1 1 260px; }
.subtitle-show-filter select { min-height: 34px; max-width: 210px; padding: 0 10px; border: 1px solid #e6eaf0; border-radius: 8px; background: #fff; color: #69758a; font-size: 9px; }
.subtitle-status-filter { width: 100%; overflow-x: auto; flex-wrap: nowrap; }
.subtitle-status-filter button { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
.subtitle-status-filter small { color: #a3adba; font-size: 8px; }
.subtitle-table-panel { overflow: hidden; }
.subtitle-table-heading, .subtitle-job-row { display: grid; grid-template-columns: minmax(205px, 1.35fr) minmax(105px, .7fr) minmax(88px, .55fr) minmax(125px, .8fr) minmax(95px, .55fr) auto; align-items: center; gap: 12px; padding: 12px 17px; }
.subtitle-table-heading { border-bottom: 1px solid #edf0f5; background: #fbfcfe; color: #9ca5b3; font-size: 8px; font-weight: 700; }
.subtitle-job-row { min-height: 68px; border-bottom: 1px solid #f0f2f6; }
.subtitle-job-row:last-child { border-bottom: 0; }
.subtitle-job-main { display: flex; min-width: 0; align-items: center; gap: 9px; padding: 0; border: 0; background: transparent; cursor: pointer; text-align: left; }
.subtitle-job-main:hover .subtitle-job-copy strong { color: #3978f6; }
.subtitle-job-mark { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; border-radius: 9px; background: #f1f4f8; color: #768397; font-size: 11px; font-weight: 800; }
.subtitle-job-mark.job-completed { background: #e8f8f1; color: #1c9c72; }
.subtitle-job-mark.job-pending { background: #fff5e6; color: #c68428; }
.subtitle-job-mark.job-processing { background: #edf4ff; color: #3c74d7; }
.subtitle-job-mark.job-failed { background: #fff0f0; color: #d45959; }
.subtitle-job-mark.job-uncertain { background: #fff2e6; color: #bd762a; }
.status-chip.chip-completed { background: #eaf8f2; color: #208363; }
.status-chip.chip-uncertain { background: #fff2e6; color: #bd762a; }
.subtitle-job-copy, .subtitle-job-languages { display: block; min-width: 0; }
.subtitle-job-copy strong, .subtitle-job-copy small, .subtitle-job-languages strong, .subtitle-job-languages small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subtitle-job-copy strong, .subtitle-job-languages strong { color: #465167; font-size: 9px; }
.subtitle-job-copy small, .subtitle-job-languages small { margin-top: 5px; color: #9da6b4; font-size: 8px; }
.subtitle-job-storage, .subtitle-job-time { overflow: hidden; color: #818c9f; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.subtitle-error-code { display: block; margin-top: 4px; color: #c47a42; font-size: 8px; overflow-wrap: anywhere; }
.subtitle-job-actions { display: flex; justify-content: flex-end; }
.subtitle-language-field { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 0; padding: 11px 12px; border: 1px solid #e9edf3; border-radius: 8px; color: #68758a; font-size: 9px; }
.subtitle-language-field legend { padding: 0 5px; color: #5d687c; font-size: 10px; font-weight: 600; }
.subtitle-language-field label { display: inline-flex; align-items: center; gap: 5px; }
.subtitle-language-field input { accent-color: #3978f6; }
.subtitle-output-path { display: grid; gap: 5px; margin: 11px 0; }
.subtitle-output-path strong { color: #69758a; font-size: 9px; }
.subtitle-output-path span { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }

@media (max-width: 1100px) {
  .subtitle-table-heading { display: none; }
  .subtitle-job-row { grid-template-columns: minmax(180px, 1.5fr) minmax(90px, .8fr) minmax(88px, .65fr) auto; }
  .subtitle-job-languages { display: none; }
}

@media (max-width: 680px) {
  .subtitle-page-actions { width: 100%; justify-content: flex-start; }
  .subtitle-page-actions .button { flex: 1; }
  .subtitle-toolbar .search-field { flex-basis: 100%; }
  .subtitle-show-filter, .subtitle-show-filter select { width: 100%; max-width: none; }
  .subtitle-job-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 11px 12px; }
  .subtitle-job-main { grid-column: 1; grid-row: 1 / span 2; }
  .subtitle-job-storage { display: none; }
  .subtitle-job-row > span:nth-child(3) { grid-column: 2; grid-row: 1; text-align: right; }
  .subtitle-job-time { grid-column: 2; grid-row: 2; text-align: right; }
  .subtitle-job-actions { grid-column: 2; grid-row: 3; }
}
</style>

<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { errorMessage, eventTitle, formatDate, statusLabel } from '../lib/format.js';

const api = inject('api');
const notify = inject('notify');
const records = ref([]);
const shows = ref([]);
const loading = ref(true);
const loadError = ref('');
const query = ref('');
const outcome = ref('all');
const selectedRecord = ref(null);

const terminalRecords = computed(() => records.value.filter((event) =>
  ['processed', 'skipped', 'failed'].includes(event.status)));
const successfulCount = computed(() => terminalRecords.value.filter((event) => event.status === 'processed').length);
const failedCount = computed(() => terminalRecords.value.filter((event) => event.status === 'failed').length);
const skippedCount = computed(() => terminalRecords.value.filter((event) => event.status === 'skipped').length);
const visibleRecords = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return terminalRecords.value.filter((event) => {
    const matchesOutcome = outcome.value === 'all' || event.status === outcome.value;
    const show = shows.value.find((item) => item.id === event.showId);
    const text = [eventTitle(event), show?.name, event.kind, event.source, event.showId]
      .filter(Boolean).join(' ').toLowerCase();
    return matchesOutcome && (!needle || text.includes(needle));
  });
});

async function load() {
  loading.value = true;
  try {
    const [eventResponse, showResponse] = await Promise.all([
      api.request('/api/events?limit=1000'),
      api.request('/api/shows'),
    ]);
    records.value = eventResponse.items || [];
    shows.value = showResponse.items || [];
    loadError.value = '';
  } catch (error) {
    loadError.value = errorMessage(error);
    notify(errorMessage(error), 'error');
  } finally {
    loading.value = false;
  }
}

function showName(event) {
  return shows.value.find((show) => show.id === event.showId)?.name || (event.showId ? `节目 #${event.showId}` : '系统事件');
}

function elapsed(event) {
  if (!event.startedAt || !event.completedAt) return '—';
  const duration = new Date(event.completedAt).getTime() - new Date(event.startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return '—';
  if (duration < 1000) return '< 1 秒';
  if (duration < 60000) return `${Math.round(duration / 1000)} 秒`;
  return `${Math.floor(duration / 60000)} 分钟`;
}

function safePayload(payload = {}) {
  return Object.entries(payload)
    .filter(([key, value]) => value != null && !/url|uri|link|token|cookie|password|secret|authorization/i.test(key))
    .slice(0, 12)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)]);
}

onMounted(load);
</script>

<template>
  <div class="view-stack">
    <div class="page-intro"><div><h2>回看每次追更的处理结果。</h2><p>历史来自持久化追更事件，按完成、跳过和失败状态整理。</p></div><button class="button button-secondary" type="button" :disabled="loading" @click="load"><span class="button-icon">⟳</span>{{ loading ? '正在刷新' : '刷新记录' }}</button></div>

    <div class="metric-grid update-metrics">
      <article class="metric-card"><div class="metric-top"><span>已处理</span><span class="metric-icon mint">✓</span></div><div class="metric-value">{{ successfulCount }}<small> 条</small></div><div class="metric-foot">工作流已完成的追更事件</div></article>
      <article class="metric-card"><div class="metric-top"><span>已跳过</span><span class="metric-icon blue">·</span></div><div class="metric-value">{{ skippedCount }}<small> 条</small></div><div class="metric-foot">无需写入或未找到可追集内容</div></article>
      <article class="metric-card"><div class="metric-top"><span>处理失败</span><span class="metric-icon amber">!</span></div><div class="metric-value">{{ failedCount }}<small> 条</small></div><div class="metric-foot">重试前先核对目标目录状态</div></article>
      <article class="metric-card"><div class="metric-top"><span>已加载记录</span><span class="metric-icon lilac">≋</span></div><div class="metric-value">{{ terminalRecords.length }}<small> / {{ records.length }} 条</small></div><div class="metric-foot">最近 1,000 条事件中的终态记录</div></article>
    </div>

    <section class="panel toolbar-panel events-toolbar"><div class="search-field"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索节目、事件类型或来源" /></div><div class="filter-tabs"><button v-for="option in [{ id: 'all', label: '全部结果' }, { id: 'processed', label: '已处理' }, { id: 'skipped', label: '已跳过' }, { id: 'failed', label: '失败' }]" :key="option.id" type="button" :class="{ selected: outcome === option.id }" @click="outcome = option.id">{{ option.label }}</button></div></section>

    <section class="panel event-table-panel">
      <div class="update-table-heading"><span>处理时间</span><span>节目 / 事件</span><span>结果</span><span>耗时</span><span>尝试</span><span></span></div>
      <div v-if="loadError && records.length" class="inline-alert error-alert"><span class="alert-symbol">!</span><div><strong>更新记录未能刷新</strong><p>{{ loadError }} 当前显示的是上次成功加载的记录。</p><button class="text-button" type="button" :disabled="loading" @click="load">重试 <span>→</span></button></div></div>
      <div v-if="loading" class="table-loading"><div v-for="index in 5" :key="index" class="skeleton-line"></div></div>
      <div v-else-if="loadError && !records.length" class="empty-state compact-empty"><div class="empty-illustration">!</div><strong>无法加载更新记录</strong><p>{{ loadError }}</p><button class="button button-secondary" type="button" @click="load">重试</button></div>
      <div v-else-if="!visibleRecords.length" class="empty-state compact-empty"><div class="empty-illustration">≋</div><strong>{{ terminalRecords.length ? '没有符合条件的记录' : '还没有已完成的追更记录' }}</strong><p>{{ terminalRecords.length ? '调整搜索内容或筛选状态。' : '事件完成、跳过或失败后，会出现在这里。' }}</p></div>
      <div v-else class="update-table">
        <button v-for="event in visibleRecords" :key="event.id" class="update-row" type="button" @click="selectedRecord = event">
          <span class="update-time">{{ formatDate(event.completedAt || event.updatedAt) }}</span>
          <span class="update-title"><strong>{{ eventTitle(event) }}</strong><small>{{ showName(event) }} · {{ event.kind }} · {{ event.source || 'manual' }}</small></span>
          <span><span class="status-chip" :class="'chip-' + event.status">{{ statusLabel(event.status) }}</span></span>
          <span class="table-secondary">{{ elapsed(event) }}</span>
          <span class="table-secondary">{{ event.attemptCount ?? 0 }}</span>
          <span class="update-chevron">›</span>
        </button>
      </div>
      <div class="table-footer">此页展示 update_event 工作流事件，不包含插件调用审计日志。</div>
    </section>

    <Teleport to="body">
      <div v-if="selectedRecord" class="modal-backdrop" @click.self="selectedRecord = null"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="update-record-title"><div class="modal-heading"><div><span class="modal-kicker">更新记录 / #{{ selectedRecord.id }}</span><h2 id="update-record-title">{{ eventTitle(selectedRecord) }}</h2><p>{{ showName(selectedRecord) }} · {{ selectedRecord.kind }}</p></div><button class="icon-button" type="button" aria-label="关闭" @click="selectedRecord = null">×</button></div><div class="event-detail-facts"><div><span>结果</span><strong><span class="status-chip" :class="'chip-' + selectedRecord.status">{{ statusLabel(selectedRecord.status) }}</span></strong></div><div><span>来源</span><strong>{{ selectedRecord.source }}</strong></div><div><span>开始时间</span><strong>{{ formatDate(selectedRecord.startedAt) }}</strong></div><div><span>完成时间</span><strong>{{ formatDate(selectedRecord.completedAt) }}</strong></div><div><span>运行时长</span><strong>{{ elapsed(selectedRecord) }}</strong></div><div><span>处理尝试</span><strong>{{ selectedRecord.attemptCount }}</strong></div></div><div class="section-rule"><span>安全摘要</span></div><div v-if="safePayload(selectedRecord.payload).length" class="payload-list"><div v-for="([key, value]) in safePayload(selectedRecord.payload)" :key="key">{{ key }}: {{ value }}</div></div><div v-else class="helper-panel">没有可展示的事件摘要字段。</div><div v-if="selectedRecord.status === 'failed'" class="inline-alert error-alert"><span class="alert-symbol">!</span><div><strong>处理失败</strong><p>若处理已尝试写入媒体，先检查目标目录，再从追更事件页决定是否安全重试。</p></div></div><div class="modal-actions"><button class="button button-quiet" type="button" @click="selectedRecord = null">关闭</button></div></section></div>
    </Teleport>
  </div>
</template>

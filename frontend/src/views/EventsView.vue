<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { errorMessage, eventTitle, formatDate, statusLabel } from '../lib/format.js';

const api = inject('api');
const notify = inject('notify');
const refreshConnection = inject('refreshConnection');
const events = ref([]);
const shows = ref([]);
const loading = ref(true);
const filter = ref('all');
const query = ref('');
const confirmEvent = ref(null);
const processingId = ref(null);
const retryingId = ref(null);
const detailsEvent = ref(null);
const recoveryEvent = ref(null);
const recoveryWorkerConfirmed = ref(false);
const recoveryOutputConfirmed = ref(false);
const recoveryNoOutputConfirmed = ref(false);
const recoveringId = ref(null);
const visibleEvents = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return events.value.filter((event) => {
    const matchesStatus = filter.value === 'all' || event.status === filter.value;
    const show = shows.value.find((item) => item.id === event.showId);
    const haystack = [eventTitle(event), event.kind, event.source, show?.name, event.showId]
      .filter(Boolean).join(' ').toLowerCase();
    return matchesStatus && (!needle || haystack.includes(needle));
  });
});

async function load() {
  loading.value = true;
  try {
    const [eventResponse, showResponse] = await Promise.all([
      api.request('/api/events?limit=1000'),
      api.request('/api/shows'),
    ]);
    events.value = eventResponse.items || [];
    shows.value = showResponse.items || [];
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    loading.value = false;
  }
}

function showName(event) {
  return shows.value.find((show) => show.id === event.showId)?.name || (event.showId ? `节目 #${event.showId}` : '系统事件');
}

function closeProcessConfirmation() {
  if (processingId.value != null) return;
  confirmEvent.value = null;
}

async function processConfirmed() {
  const event = confirmEvent.value;
  if (!event) return;
  processingId.value = event.id;
  try {
    const result = await api.request(`/api/events/${event.id}/process`, { method: 'POST' });
    const finalStatus = result.event?.status || (result.ok ? 'processed' : 'failed');
    notify(finalStatus === 'processed' ? '事件处理完成。' : `事件状态：${statusLabel(finalStatus)}。`, finalStatus === 'processed' ? 'success' : 'warning');
    confirmEvent.value = null;
    await load();
    await refreshConnection();
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    processingId.value = null;
  }
}

async function retryEvent(event) {
  retryingId.value = event.id;
  try {
    await api.request(`/api/events/${event.id}/retry`, { method: 'POST' });
    notify('事件已回到待处理状态。');
    detailsEvent.value = null;
    await load();
    await refreshConnection();
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    retryingId.value = null;
  }
}

function openRecovery(event) {
  recoveryEvent.value = event;
  recoveryWorkerConfirmed.value = false;
  recoveryOutputConfirmed.value = false;
  recoveryNoOutputConfirmed.value = false;
  detailsEvent.value = null;
}

function closeRecovery() {
  if (recoveringId.value != null) return;
  recoveryEvent.value = null;
  recoveryWorkerConfirmed.value = false;
  recoveryOutputConfirmed.value = false;
  recoveryNoOutputConfirmed.value = false;
}

async function recoverInterrupted(action) {
  const event = recoveryEvent.value;
  if (!event) return;
  if (!recoveryWorkerConfirmed.value) return;
  if (action === 'complete' && !recoveryOutputConfirmed.value) return;
  if (action === 'retry_after_review' && !recoveryNoOutputConfirmed.value) return;
  recoveringId.value = event.id;
  try {
    const result = await api.request(`/api/events/${event.id}/recover`, {
      method: 'POST',
      body: {
        action,
        confirmNoActiveWorker: true,
        ...(action === 'complete' ? { confirmOutputsMatch: true } : {}),
        ...(action === 'retry_after_review' ? { confirmNoOutput: true } : {}),
      },
    });
    notify(result.resolution === 'processed'
      ? '已核对媒体并完成事件。'
      : '已确认目标目录没有本次媒体；事件可安全重试。');
    recoveryEvent.value = null;
    recoveryWorkerConfirmed.value = false;
    recoveryOutputConfirmed.value = false;
    recoveryNoOutputConfirmed.value = false;
    await load();
    await refreshConnection();
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    recoveringId.value = null;
  }
}

function summarizePayload(payload = {}) {
  return Object.entries(payload)
    .filter(([key, value]) => value != null && !/url|uri|link|token|cookie|password|secret|authorization/i.test(key))
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : value}`);
}

onMounted(load);
</script>

<template>
  <div class="view-stack">
    <div class="page-intro"><div><h2>追更流程的每一步都有记录。</h2><p>处理待办、查看失败原因，并复核服务中断时留下的写入状态。</p></div><button class="button button-secondary" type="button" :disabled="loading" @click="load"><span class="button-icon">⟳</span>{{ loading ? '正在刷新' : '刷新事件' }}</button></div>

    <section class="panel toolbar-panel events-toolbar"><div class="search-field"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索节目、事件类型或来源" /></div><div class="filter-tabs"><button v-for="option in [{ id: 'all', label: '全部' }, { id: 'pending', label: '待处理' }, { id: 'processing', label: '处理中' }, { id: 'processed', label: '已完成' }, { id: 'failed', label: '失败' }, { id: 'skipped', label: '已跳过' }]" :key="option.id" type="button" :class="{ selected: filter === option.id }" @click="filter = option.id">{{ option.label }}</button></div></section>

    <section class="panel event-table-panel">
      <div class="table-heading"><span>事件 / 节目</span><span>状态</span><span>来源</span><span>尝试</span><span>创建时间</span><span>操作</span></div>
      <div v-if="loading" class="table-loading"><div v-for="index in 5" :key="index" class="skeleton-line"></div></div>
      <div v-else-if="!visibleEvents.length" class="empty-state compact-empty"><div class="empty-illustration">↻</div><strong>{{ events.length ? '没有匹配的事件' : '还没有追更事件' }}</strong><p>{{ events.length ? '调整筛选条件后再试。' : '通过节目详情中的资源预览创建追更事件。' }}</p></div>
      <div v-else class="event-table">
        <div v-for="event in visibleEvents" :key="event.id" class="table-row">
          <button class="event-name-cell" type="button" @click="detailsEvent = event"><span class="event-row-mark" :class="'status-' + event.status">{{ event.status === 'processed' ? '✓' : event.status === 'failed' ? '!' : '·' }}</span><span><strong>{{ eventTitle(event) }}</strong><small>{{ showName(event) }} · {{ event.kind }} · #{{ event.id }}</small></span></button>
          <span><span class="status-chip" :class="'chip-' + event.status">{{ statusLabel(event.status) }}</span></span>
          <span class="table-secondary">{{ event.source || 'manual' }}</span>
          <span class="table-secondary">{{ event.attemptCount ?? 0 }}</span>
          <span class="table-secondary">{{ formatDate(event.createdAt) }}</span>
          <span class="table-actions"><button v-if="event.kind === 'new_ep' && event.status === 'pending'" class="button button-primary button-small" type="button" @click="confirmEvent = event">处理</button><button v-else-if="event.kind === 'new_ep' && (event.status === 'processing' || (event.status === 'failed' && !event.retryable))" class="button button-secondary button-small" type="button" @click="openRecovery(event)">{{ event.status === 'processing' ? '中断复核' : '写入复核' }}</button><button v-else-if="event.status === 'failed' && event.retryable" class="button button-secondary button-small" type="button" :disabled="retryingId === event.id" @click="retryEvent(event)">{{ retryingId === event.id ? '检查中…' : '安全重试' }}</button><button v-else class="icon-button small" type="button" aria-label="查看详情" @click="detailsEvent = event">›</button></span>
        </div>
      </div>
      <div class="table-footer">最多显示最近 1,000 条事件。事件状态由追更工作流管理。</div>
    </section>

    <Teleport to="body">
      <div v-if="confirmEvent" class="modal-backdrop" @click.self="closeProcessConfirmation"><section class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="process-confirm-title"><div class="confirm-icon">!</div><span class="modal-kicker">写入操作确认</span><h2 id="process-confirm-title">开始处理这条追更事件？</h2><p>将为「{{ showName(confirmEvent) }}」处理已选中的媒体文件，并写入对应的存储位置。处理失败时若写入结果不确定，需要先检查目标目录再重试。</p><div class="confirm-event-summary"><strong>{{ eventTitle(confirmEvent) }}</strong><small>事件 #{{ confirmEvent.id }} · {{ confirmEvent.payload?.selectedFileCount ?? '已确认文件' }}</small></div><div class="modal-actions"><button class="button button-quiet" type="button" :disabled="processingId === confirmEvent.id" @click="closeProcessConfirmation">返回检查</button><button class="button button-danger" type="button" :disabled="processingId === confirmEvent.id" @click="processConfirmed">{{ processingId === confirmEvent.id ? '正在处理…' : '确认处理' }}</button></div></section></div>
      <div v-if="detailsEvent" class="modal-backdrop" @click.self="detailsEvent = null">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="event-detail-title">
          <div class="modal-heading">
            <div><span class="modal-kicker">事件详情 / #{{ detailsEvent.id }}</span><h2 id="event-detail-title">{{ eventTitle(detailsEvent) }}</h2><p>{{ showName(detailsEvent) }} · {{ detailsEvent.kind }}</p></div>
            <button class="icon-button" type="button" aria-label="关闭" @click="detailsEvent = null">×</button>
          </div>
          <div class="event-detail-facts">
            <div><span>状态</span><strong><span class="status-chip" :class="'chip-' + detailsEvent.status">{{ statusLabel(detailsEvent.status) }}</span></strong></div>
            <div><span>来源</span><strong>{{ detailsEvent.source }}</strong></div>
            <div><span>尝试次数</span><strong>{{ detailsEvent.attemptCount }}</strong></div>
            <div><span>创建时间</span><strong>{{ formatDate(detailsEvent.createdAt) }}</strong></div>
          </div>
          <div class="section-rule"><span>事件摘要</span></div>
          <div v-if="summarizePayload(detailsEvent.payload).length" class="payload-list"><div v-for="line in summarizePayload(detailsEvent.payload)" :key="line">{{ line }}</div></div>
          <div v-else class="helper-panel">没有可展示的事件摘要字段。</div>
          <div v-if="detailsEvent.kind === 'new_ep' && detailsEvent.status === 'processing'" class="inline-alert warning-alert">
            <span class="alert-symbol">!</span><div><strong>处理中断复核</strong><p>如果服务重启可能让事件停留在处理中。复核前请确认没有其他应用实例仍在处理这条事件。</p></div>
          </div>
          <div v-else-if="detailsEvent.status === 'failed'" class="inline-alert error-alert">
            <span class="alert-symbol">!</span><div><strong>事件处理失败</strong><p>{{ detailsEvent.retryable ? '服务端确认没有未决写入占位，可以安全重试。' : '写入占位仍保留；先检查目标目录并使用写入复核，确认已保存或确认没有媒体后再继续。' }}</p></div>
          </div>
          <div class="modal-actions">
            <button class="button button-quiet" type="button" @click="detailsEvent = null">关闭</button>
            <button v-if="detailsEvent.kind === 'new_ep' && detailsEvent.status === 'pending'" class="button button-primary" type="button" @click="confirmEvent = detailsEvent; detailsEvent = null">处理事件</button>
            <button v-else-if="detailsEvent.kind === 'new_ep' && (detailsEvent.status === 'processing' || (detailsEvent.status === 'failed' && !detailsEvent.retryable))" class="button button-secondary" type="button" @click="openRecovery(detailsEvent)">{{ detailsEvent.status === 'processing' ? '中断复核' : '写入复核' }}</button>
            <button v-else-if="detailsEvent.status === 'failed' && detailsEvent.retryable" class="button button-secondary" type="button" :disabled="retryingId === detailsEvent.id" @click="retryEvent(detailsEvent)">{{ retryingId === detailsEvent.id ? '检查中…' : '安全重试' }}</button>
          </div>
        </section>
      </div>
      <div v-if="recoveryEvent" class="modal-backdrop" @click.self="closeRecovery"><section class="modal confirm-modal recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><div class="confirm-icon">↻</div><span class="modal-kicker">#{{ recoveryEvent.id }} · {{ recoveryEvent.status === 'processing' ? '中断复核' : '写入复核' }}</span><h2 id="recovery-title">核对这次转存停在了哪一步</h2><p>服务不会再次保存分享文件。它会重新读取 Season {{ String(recoveryEvent.payload?.seasonNumber || '').padStart(2, '0') }}：文件名和大小只能筛选候选，不能证明文件来自本次转存。完成操作会继续整理目录、同步资产和刷新索引；确认无输出后才会开放人工重试。</p><div class="confirm-event-summary"><strong>{{ eventTitle(recoveryEvent) }}</strong><small>{{ showName(recoveryEvent) }} · {{ recoveryEvent.payload?.selectedFiles?.length ?? '所选媒体文件' }} 个文件</small></div><label class="recovery-confirm"><input v-model="recoveryWorkerConfirmed" type="checkbox" /><span>我已确认没有其他应用实例正在处理这条事件。</span></label><label class="recovery-confirm"><input v-model="recoveryOutputConfirmed" type="checkbox" /><span>若选择完成，我确认目标目录中的所选文件确实属于本次事件。</span></label><label class="recovery-confirm"><input v-model="recoveryNoOutputConfirmed" type="checkbox" /><span>若选择重试，我已检查目标目录，确认其中没有本次所选媒体。</span></label><div class="modal-actions"><button class="button button-quiet" type="button" :disabled="recoveringId === recoveryEvent.id" @click="closeRecovery">返回</button><button class="button button-secondary" type="button" :disabled="recoveringId === recoveryEvent.id || !recoveryWorkerConfirmed || !recoveryOutputConfirmed" @click="recoverInterrupted('complete')">{{ recoveringId === recoveryEvent.id ? '正在核对…' : '核对并完成' }}</button><button class="button button-danger" type="button" :disabled="recoveringId === recoveryEvent.id || !recoveryWorkerConfirmed || !recoveryNoOutputConfirmed" @click="recoverInterrupted('retry_after_review')">确认无媒体并允许重试</button></div></section></div>
    </Teleport>
  </div>
</template>

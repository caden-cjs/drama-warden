<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { errorMessage, eventTitle, formatDate, statusLabel } from '../lib/format.js';

const api = inject('api');
const notify = inject('notify');
const shows = ref([]);
const events = ref([]);
const plugins = ref([]);
const automation = ref(null);
const health = ref(null);
const scanResult = ref(null);
const loading = ref(true);
const scanLoading = ref(false);
const loadError = ref('');
const openShows = computed(() => shows.value.filter((show) => !show.finished).length);
const enabledPlugins = computed(() => plugins.value.filter((plugin) => plugin.enabled).length);
const pendingEvents = computed(() => events.value.filter((event) => event.status === 'pending'));
const recentEvents = computed(() => events.value.slice(0, 6));
const scanCandidates = computed(() => scanResult.value?.candidates || []);

async function load() {
  loading.value = true;
  loadError.value = '';
  const results = await Promise.allSettled([
    api.request('/api/shows'),
    api.request('/api/events?limit=100'),
    api.request('/api/plugins'),
    api.request('/api/automation/status'),
    api.request('/api/health'),
  ]);
  const [showResult, eventResult, pluginResult, automationResult, healthResult] = results;
  if (showResult.status === 'fulfilled') shows.value = showResult.value.items || [];
  if (eventResult.status === 'fulfilled') events.value = eventResult.value.items || [];
  if (pluginResult.status === 'fulfilled') plugins.value = pluginResult.value.items || [];
  if (automationResult.status === 'fulfilled') automation.value = automationResult.value.automation;
  if (healthResult.status === 'fulfilled') health.value = healthResult.value;
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) loadError.value = errorMessage(rejected.reason);
  loading.value = false;
}

async function runScan() {
  scanLoading.value = true;
  scanResult.value = null;
  try {
    scanResult.value = await api.request('/api/automation/scan', { method: 'POST' });
    notify(`预览完成：检查 ${scanResult.value.showsChecked ?? 0} 部节目，发现 ${scanResult.value.candidatesFound ?? 0} 个候选。`);
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    scanLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="view-stack">
    <div class="page-intro">
      <div>
        <h2>追更状态，一目了然。</h2>
        <p>查看节目进度、待处理事件和自动化运行情况。</p>
      </div>
      <button class="button button-secondary" type="button" :disabled="loading" @click="load">
        <span class="button-icon">⟳</span>{{ loading ? '正在刷新' : '刷新数据' }}
      </button>
    </div>

    <div v-if="loadError" class="inline-alert error-alert">
      <span class="alert-symbol">!</span>
      <div><strong>部分数据未能加载</strong><p>{{ loadError }}。检查访问令牌或服务状态。</p></div>
    </div>

    <div class="metric-grid">
      <article class="metric-card">
        <div class="metric-top"><span>追更中的节目</span><span class="metric-icon lilac">▣</span></div>
        <div class="metric-value">{{ openShows }}<small> / {{ shows.length }} 部</small></div>
        <div class="metric-foot">已完成节目 {{ shows.length - openShows }} 部</div>
      </article>
      <article class="metric-card">
        <div class="metric-top"><span>待处理事件</span><span class="metric-icon amber">↻</span></div>
        <div class="metric-value">{{ pendingEvents.length }}<small> 条</small></div>
        <div class="metric-foot">最近 {{ events.length }} 条事件记录</div>
      </article>
      <article class="metric-card">
        <div class="metric-top"><span>已启用插件</span><span class="metric-icon mint">◇</span></div>
        <div class="metric-value">{{ enabledPlugins }}<small> / {{ plugins.length }} 个</small></div>
        <div class="metric-foot">插件通过能力契约接入</div>
      </article>
      <article class="metric-card">
        <div class="metric-top"><span>数据库状态</span><span class="metric-icon blue">⌁</span></div>
        <div class="metric-value metric-state" :class="health?.database === 'ok' ? 'text-good' : 'text-muted'">
          {{ health?.database === 'ok' ? '正常' : health?.database === 'unavailable' ? '不可用' : '检查中' }}
        </div>
        <div class="metric-foot">{{ health?.service || 'drama-warden' }} 服务健康检查</div>
      </article>
    </div>

    <div class="content-grid overview-grid">
      <section class="panel panel-large">
        <div class="panel-heading">
          <div><h3>最近追更事件</h3><p>查看最新状态与处理结果</p></div>
          <span class="subtle-count">{{ events.length }} 条记录</span>
        </div>
        <div v-if="!recentEvents.length && !loading" class="empty-state compact-empty">
          <div class="empty-illustration">↻</div><strong>还没有追更事件</strong><p>添加节目并完成元数据关联后，可以开始预览追更。</p>
        </div>
        <div v-else class="event-list">
          <div v-for="event in recentEvents" :key="event.id" class="event-row">
            <div class="event-leading" :class="'status-' + event.status">{{ event.status === 'processed' ? '✓' : event.status === 'failed' ? '!' : '·' }}</div>
            <div class="event-copy">
              <strong>{{ eventTitle(event) }}</strong>
              <small>{{ event.kind }} <span>·</span> {{ event.source || 'manual' }} <span>·</span> {{ formatDate(event.createdAt) }}</small>
            </div>
            <span class="status-chip" :class="'chip-' + event.status">{{ statusLabel(event.status) }}</span>
          </div>
        </div>
      </section>

      <section class="panel automation-panel">
        <div class="panel-heading">
          <div><h3>自动化</h3><p>只读扫描预览</p></div>
          <span class="automation-light" :class="automation?.enabled ? 'enabled' : ''"></span>
        </div>
        <div class="automation-status-card">
          <div class="automation-state-icon">⟳</div>
          <div>
            <strong>{{ automation?.enabled ? '周期扫描已启用' : '周期扫描已关闭' }}</strong>
            <small>{{ automation?.enabled ? `每 ${automation.intervalMinutes} 分钟扫描一次` : '可手动运行一次候选预览' }}</small>
          </div>
        </div>
        <div class="automation-facts">
          <div><span>媒体自动处理</span><strong>{{ automation?.autoProcess ? '已启用' : '关闭' }}</strong></div>
          <div><span>最近扫描</span><strong>{{ formatDate(automation?.lastRun?.completedAt || automation?.lastStartedAt) }}</strong></div>
          <div><span>本次运行</span><strong>{{ automation?.running ? '运行中' : '空闲' }}</strong></div>
        </div>
        <button class="button button-primary button-full" type="button" :disabled="scanLoading" @click="runScan">
          {{ scanLoading ? '正在扫描候选…' : '运行只读预览' }}
          <span aria-hidden="true">→</span>
        </button>
        <p class="helper-note">此预览不会排队事件，也不会写入媒体文件。</p>
      </section>
    </div>

    <section v-if="scanResult" class="panel scan-panel">
      <div class="panel-heading">
        <div><h3>最近一次预览</h3><p>完成于 {{ formatDate(scanResult.completedAt) }}</p></div>
        <span class="status-chip chip-processed">只读预览</span>
      </div>
      <div class="scan-summary">
        <div><strong>{{ scanResult.showsChecked || 0 }}</strong><span>检查节目</span></div>
        <div><strong>{{ scanResult.storagesChecked || 0 }}</strong><span>检查位置</span></div>
        <div><strong>{{ scanResult.candidatesFound || 0 }}</strong><span>搜索结果</span></div>
        <div><strong>{{ scanResult.eligibleCandidates || 0 }}</strong><span>可追候选</span></div>
      </div>
      <div v-if="scanCandidates.length" class="candidate-table-wrap">
        <div class="candidate-row candidate-header"><span>节目 / 分享</span><span>资源来源</span><span>判断</span></div>
        <div v-for="(candidate, index) in scanCandidates.slice(0, 8)" :key="`${candidate.storageId}-${candidate.sourceId || index}`" class="candidate-row">
          <div><strong>{{ candidate.showName }}</strong><small>{{ candidate.title || '未命名资源' }}</small></div>
          <span>{{ candidate.providerId }}</span>
          <span class="status-chip" :class="candidate.preview?.eligible && candidate.searchComplete ? 'chip-processed' : 'chip-muted'">
            {{ candidate.preview?.eligible ? '可追更' : '需复核' }}
          </span>
        </div>
      </div>
      <p v-else class="empty-note">本次没有发现资源候选。</p>
    </section>
  </div>
</template>

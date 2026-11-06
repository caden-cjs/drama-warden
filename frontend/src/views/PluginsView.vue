<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { errorMessage, formatDate, providerTitle } from '../lib/format.js';

const api = inject('api');
const notify = inject('notify');
const plugins = ref([]);
const loading = ref(true);
const busyPlugins = ref({});
const pluginChecks = ref({});
const pluginCalls = ref([]);
const callsLoading = ref(false);
const callOffset = ref(0);
const callsHasMore = ref(false);
const callPluginFilter = ref('');
const callOutcomeFilter = ref('all');
const groups = computed(() => {
  const entries = [
    ['metadata', '元数据'],
    ['resource', '资源搜索'],
    ['storage', '存储'],
    ['indexer', '索引'],
    ['notification', '通知'],
    ['subtitle', '字幕'],
    ['workflow', '工作流'],
  ];
  return entries.map(([domain, label]) => ({
    domain,
    label,
    items: plugins.value.filter((plugin) => Object.values(plugin.capabilityDomains || {})
      .some((domains) => domains.includes(domain))),
  })).filter((group) => group.items.length);
});

async function load() {
  loading.value = true;
  try {
    const response = await api.request('/api/plugins');
    plugins.value = response.items || [];
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    loading.value = false;
  }
  await loadCalls();
}

async function loadCalls({ append = false } = {}) {
  callsLoading.value = true;
  const offset = append ? callOffset.value : 0;
  const query = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (callPluginFilter.value) query.set('pluginId', callPluginFilter.value);
  if (callOutcomeFilter.value !== 'all') {
    query.set('ok', callOutcomeFilter.value === 'success' ? 'true' : 'false');
  }
  try {
    const response = await api.request(`/api/plugin-calls?${query}`);
    const items = response.items || [];
    pluginCalls.value = append ? [...pluginCalls.value, ...items] : items;
    callOffset.value = offset + items.length;
    callsHasMore.value = items.length === 100;
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    callsLoading.value = false;
  }
}

async function changeCallFilter() {
  await loadCalls();
}

function canMove(plugin, direction) {
  const peers = plugins.value.filter((item) => item.kind === plugin.kind)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const index = peers.findIndex((item) => item.id === plugin.id);
  return direction === 'up' ? index > 0 : index >= 0 && index < peers.length - 1;
}

async function updatePlugin(plugin, body, message) {
  busyPlugins.value = { ...busyPlugins.value, [plugin.id]: true };
  try {
    const response = await api.request(`/api/plugins/${encodeURIComponent(plugin.id)}`, {
      method: 'PUT',
      body,
    });
    plugins.value = response.items || [];
    notify(message);
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    busyPlugins.value = { ...busyPlugins.value, [plugin.id]: false };
  }
}

async function togglePlugin(plugin) {
  await updatePlugin(
    plugin,
    { enabled: !plugin.enabled },
    plugin.enabled ? '插件已停用。' : '插件已启用。',
  );
}

async function movePlugin(plugin, direction) {
  busyPlugins.value = { ...busyPlugins.value, [plugin.id]: true };
  try {
    const response = await api.request(`/api/plugins/${encodeURIComponent(plugin.id)}/move`, {
      method: 'POST',
      body: { direction },
    });
    plugins.value = response.items || [];
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    busyPlugins.value = { ...busyPlugins.value, [plugin.id]: false };
  }
}

async function checkPlugin(plugin) {
  busyPlugins.value = { ...busyPlugins.value, [plugin.id]: true };
  try {
    const response = await api.request(`/api/plugins/${encodeURIComponent(plugin.id)}/monitor`, {
      method: 'POST',
    });
    const result = response.result;
    pluginChecks.value = { ...pluginChecks.value, [plugin.id]: result };
    notify(result.ok ? '插件自检通过。' : `插件自检未通过${result.errorCode ? `：${result.errorCode}` : '。'}`,
      result.ok ? 'success' : 'warning');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    busyPlugins.value = { ...busyPlugins.value, [plugin.id]: false };
  }
}

async function resetPlugin(plugin) {
  if (!window.confirm('将执行此插件实现的 reset 操作。具体效果取决于插件代码，请只对可信插件使用。继续吗？')) return;
  busyPlugins.value = { ...busyPlugins.value, [plugin.id]: true };
  try {
    await api.request(`/api/plugins/${encodeURIComponent(plugin.id)}/reset`, { method: 'POST' });
    pluginChecks.value = { ...pluginChecks.value, [plugin.id]: null };
    notify('插件重置完成。', 'info');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    busyPlugins.value = { ...busyPlugins.value, [plugin.id]: false };
  }
}

onMounted(load);
</script>

<template>
  <div class="view-stack">
    <div class="page-intro"><div><h2>能力由插件提供，边界清晰。</h2><p>管理启停和调用顺序，并检查各插件的运行状态。</p></div><button class="button button-secondary" type="button" :disabled="loading" @click="load"><span class="button-icon">⟳</span>{{ loading ? '正在刷新' : '刷新插件' }}</button></div>
    <div class="plugin-summary-grid"><div class="plugin-summary-card"><span class="metric-icon lilac">◇</span><div><strong>{{ plugins.length }}</strong><small>已注册插件</small></div></div><div class="plugin-summary-card"><span class="metric-icon mint">✓</span><div><strong>{{ plugins.filter((plugin) => plugin.enabled).length }}</strong><small>正在启用</small></div></div><div class="plugin-summary-card"><span class="metric-icon blue">⌘</span><div><strong>{{ new Set(plugins.flatMap((plugin) => plugin.capabilities || [])).size }}</strong><small>声明能力</small></div></div></div>
    <div v-if="loading" class="loading-grid"><div v-for="index in 3" :key="index" class="skeleton-card"></div></div>
    <div v-else-if="!plugins.length" class="panel empty-state"><div class="empty-illustration">◇</div><strong>当前没有注册插件</strong><p>检查服务启动配置和插件加载日志。</p></div>
    <section v-for="group in groups" :key="group.domain" class="plugin-group">
      <div class="plugin-group-heading"><div><span class="eyebrow">CAPABILITY DOMAIN</span><h3>{{ group.label }}</h3></div><span class="subtle-count">{{ group.items.length }} 个插件</span></div>
      <div class="plugin-grid"><article v-for="plugin in group.items" :key="`${group.domain}-${plugin.id}`" class="panel plugin-card"><div class="plugin-card-head"><div class="plugin-mark" :class="plugin.enabled ? 'plugin-on' : ''">{{ (plugin.label || plugin.name || plugin.id).slice(0, 1).toUpperCase() }}</div><span class="status-chip" :class="plugin.enabled ? 'chip-processed' : 'chip-muted'">{{ plugin.enabled ? '已启用' : '已停用' }}</span></div><h4>{{ providerTitle(plugin) }}</h4><div class="plugin-id">{{ plugin.id }}</div><div class="plugin-meta"><span>{{ plugin.kind }}</span><span>v{{ plugin.version }}</span><span>API v{{ plugin.apiVersion }}</span></div><div class="capability-list"><span v-for="capability in plugin.capabilities" :key="capability">{{ capability }}</span></div><div class="plugin-controls"><div class="plugin-order-controls"><small>同类顺序 {{ plugin.order + 1 }}</small><button class="button button-quiet button-small" type="button" title="上移" :aria-label="`${providerTitle(plugin)} 上移`" :disabled="busyPlugins[plugin.id] || !canMove(plugin, 'up')" @click="movePlugin(plugin, 'up')">↑</button><button class="button button-quiet button-small" type="button" title="下移" :aria-label="`${providerTitle(plugin)} 下移`" :disabled="busyPlugins[plugin.id] || !canMove(plugin, 'down')" @click="movePlugin(plugin, 'down')">↓</button></div><div class="plugin-action-controls"><button class="button button-quiet button-small" type="button" :disabled="busyPlugins[plugin.id]" @click="checkPlugin(plugin)">{{ busyPlugins[plugin.id] ? '处理中…' : '自检' }}</button><button class="button button-quiet button-small" type="button" :disabled="busyPlugins[plugin.id]" @click="resetPlugin(plugin)">重置插件</button><button class="button button-small" :class="plugin.enabled ? 'button-quiet' : 'button-primary'" type="button" :disabled="busyPlugins[plugin.id]" @click="togglePlugin(plugin)">{{ plugin.enabled ? '停用' : '启用' }}</button></div></div><div v-if="pluginChecks[plugin.id]" class="plugin-check-result" :class="pluginChecks[plugin.id].ok ? 'check-ok' : 'check-error'">{{ pluginChecks[plugin.id].ok ? '最近自检通过' : `最近自检未通过${pluginChecks[plugin.id].errorCode ? ` · ${pluginChecks[plugin.id].errorCode}` : ''}` }}<span v-if="pluginChecks[plugin.id].configured === false"> · 未配置</span><span v-if="pluginChecks[plugin.id].authorized === false"> · 未授权</span></div></article></div>
    </section>
    <section class="panel event-table-panel plugin-call-panel">
      <div class="plugin-call-heading"><div><span class="eyebrow">CAPABILITY AUDIT</span><h3>插件调用记录</h3><p>记录调用能力、来源、关联 ID、结果与耗时；不存储请求或响应内容。</p></div><div class="plugin-call-filters"><select v-model="callPluginFilter" class="form-control" aria-label="按插件筛选" @change="changeCallFilter"><option value="">全部插件</option><option v-for="plugin in plugins" :key="plugin.id" :value="plugin.id">{{ providerTitle(plugin) }}</option></select><select v-model="callOutcomeFilter" class="form-control" aria-label="按结果筛选" @change="changeCallFilter"><option value="all">全部结果</option><option value="success">成功</option><option value="failed">失败</option></select></div></div>
      <div class="table-heading plugin-call-table-heading"><span>插件 / 能力</span><span>结果</span><span>来源</span><span>耗时</span><span>调用时间</span><span>关联 ID</span></div>
      <div v-if="callsLoading && !pluginCalls.length" class="table-loading"><div v-for="index in 4" :key="index" class="skeleton-line"></div></div>
      <div v-else-if="pluginCalls.length" class="event-table">
        <div v-for="call in pluginCalls" :key="call.id" class="table-row plugin-call-row">
          <span class="update-title"><strong>{{ providerTitle(plugins.find((plugin) => plugin.id === call.pluginId) || { id: call.pluginId }) }}</strong><small>{{ call.capability }} · #{{ call.id }}</small></span>
          <span class="plugin-call-result"><span class="status-chip" :class="call.ok ? 'chip-processed' : 'chip-failed'">{{ call.ok ? '成功' : '失败' }}</span><small v-if="call.errorCode" class="plugin-call-error">{{ call.errorCode }}</small></span>
          <span class="table-secondary">{{ call.source }}</span>
          <span class="table-secondary">{{ call.durationMs }} ms</span>
          <span class="table-secondary">{{ formatDate(call.calledAt) }}</span>
          <span class="table-secondary call-correlation" :title="call.correlationId || ''">{{ call.correlationId || '—' }}</span>
        </div>
      </div>
      <div v-else class="empty-state compact-empty"><strong>还没有插件调用记录</strong><p>首次调用 provider 能力后，记录会显示在这里。</p></div>
      <div class="table-footer plugin-call-footer"><span>显示最近 {{ pluginCalls.length }} 条。日志不包含插件输入、响应或凭据。</span><button v-if="callsHasMore" class="button button-quiet button-small" type="button" :disabled="callsLoading" @click="loadCalls({ append: true })">{{ callsLoading ? '正在加载…' : '加载更多' }}</button><button v-else class="button button-quiet button-small" type="button" :disabled="callsLoading" @click="loadCalls()">{{ callsLoading ? '正在刷新…' : '刷新记录' }}</button></div>
    </section>
    <div class="inline-alert info-alert"><span class="alert-symbol">i</span><div><strong>凭据由部署环境管理</strong><p>启停、顺序和自检结果保存在服务端数据库。API 密钥、Webhook、Cookie 和插件路径仍通过环境变量配置，不会在页面显示或保存。</p></div></div>
  </div>
</template>

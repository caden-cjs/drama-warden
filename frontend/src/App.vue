<script setup>
import { computed, onMounted, provide, ref } from 'vue';
import OverviewView from './views/OverviewView.vue';
import ShowsView from './views/ShowsView.vue';
import EventsView from './views/EventsView.vue';
import UpdateLogsView from './views/UpdateLogsView.vue';
import PluginsView from './views/PluginsView.vue';
import SettingsView from './views/SettingsView.vue';
import SubtitleJobsView from './views/SubtitleJobsView.vue';

const views = {
  overview: OverviewView,
  shows: ShowsView,
  events: EventsView,
  updates: UpdateLogsView,
  plugins: PluginsView,
  subtitles: SubtitleJobsView,
  settings: SettingsView,
};

const navigation = [
  { id: 'overview', label: '概览', glyph: '◫' },
  { id: 'shows', label: '节目库', glyph: '▣' },
  { id: 'events', label: '追更事件', glyph: '↻' },
  { id: 'updates', label: '更新记录', glyph: '≋' },
  { id: 'plugins', label: '插件', glyph: '◇' },
  { id: 'subtitles', label: '字幕任务', glyph: '▤' },
  { id: 'settings', label: '连接设置', glyph: '⚙' },
];

const TOKEN_KEY = 'drama-warden:api-token';
const apiToken = ref(readToken());
const activeView = ref('overview');
const connectionState = ref('checking');
const databaseState = ref('checking');
const pendingCount = ref(null);
const toastItems = ref([]);

function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function notify(message, tone = 'success') {
  const id = Date.now() + Math.random();
  toastItems.value.push({ id, message, tone });
  window.setTimeout(() => {
    toastItems.value = toastItems.value.filter((item) => item.id !== id);
  }, 4200);
}

const api = {
  async request(path, { method = 'GET', body, signal } = {}) {
    const headers = new Headers();
    if (apiToken.value.trim()) headers.set('authorization', 'Bearer ' + apiToken.value.trim());
    if (body !== undefined) headers.set('content-type', 'application/json');
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new Error('无法连接服务。确认服务地址可访问后重试。');
    }
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
      const error = new Error(payload.error || payload.code || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = payload.code;
      error.providers = payload.providers;
      throw error;
    }
    return payload;
  },
};

async function saveToken(value) {
  apiToken.value = String(value || '').trim();
  try {
    if (apiToken.value) window.localStorage.setItem(TOKEN_KEY, apiToken.value);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    notify('浏览器不允许保存本地令牌，请检查隐私设置。', 'error');
  }
  await refreshConnection();
}

async function refreshConnection() {
  connectionState.value = 'checking';
  databaseState.value = 'checking';
  try {
    const health = await api.request('/api/health');
    databaseState.value = health.database === 'ok' ? 'ok' : 'error';
  } catch {
    databaseState.value = 'error';
  }
  try {
    const [shows, pending] = await Promise.all([
      api.request('/api/shows'),
      api.request('/api/events?status=pending&limit=1000'),
    ]);
    connectionState.value = 'ok';
    pendingCount.value = pending.items?.length ?? 0;
    return shows.items || [];
  } catch (error) {
    connectionState.value = error.status === 401 ? 'unauthorized' : 'error';
    pendingCount.value = null;
    return null;
  }
}

const currentComponent = computed(() => views[activeView.value]);
const currentTitle = computed(() => navigation.find((item) => item.id === activeView.value)?.label || '概览');
const currentStatus = computed(() => {
  if (connectionState.value === 'checking') return { text: '正在连接', tone: 'muted' };
  if (connectionState.value === 'ok') return { text: '服务已连接', tone: 'good' };
  if (connectionState.value === 'unauthorized') return { text: '需要访问令牌', tone: 'warning' };
  return { text: '服务不可用', tone: 'error' };
});

provide('api', api);
provide('notify', notify);
provide('apiToken', apiToken);
provide('saveToken', saveToken);
provide('refreshConnection', refreshConnection);

onMounted(refreshConnection);
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand-lockup">
        <div class="brand-mark"><span></span><span></span><span></span></div>
        <div>
          <div class="brand-name">追剧引擎</div>
          <div class="brand-caption">DRAMA WARDEN</div>
        </div>
      </div>

      <div class="nav-label">工作台</div>
      <nav class="primary-nav" aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          class="nav-item"
          :aria-label="item.label"
          :class="{ active: activeView === item.id }"
          type="button"
          @click="activeView = item.id"
        >
          <span class="nav-glyph" aria-hidden="true">{{ item.glyph }}</span>
          <span>{{ item.label }}</span>
          <span v-if="item.id === 'events' && pendingCount" class="nav-count">{{ pendingCount }}</span>
        </button>
      </nav>

      <div class="sidebar-bottom">
        <div class="sidebar-status">
          <span class="status-led" :class="currentStatus.tone"></span>
          <div>
            <strong>{{ currentStatus.text }}</strong>
            <small>数据库 {{ databaseState === 'ok' ? '正常' : databaseState === 'checking' ? '检查中' : '不可用' }}</small>
          </div>
        </div>
        <div class="sidebar-version">开源版 · 0.1.0</div>
      </div>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div>
          <div class="eyebrow">DRAMA WARDEN / 管理控制台</div>
          <h1>{{ currentTitle }}</h1>
        </div>
        <div class="topbar-actions">
          <div class="connection-pill" :class="currentStatus.tone">
            <span class="status-led"></span>{{ currentStatus.text }}
          </div>
          <button class="icon-button" type="button" title="重新检查连接" aria-label="重新检查连接" @click="refreshConnection">
            <span aria-hidden="true">⟳</span>
          </button>
          <button class="avatar-button" type="button" title="连接设置" @click="activeView = 'settings'">DW</button>
        </div>
      </header>

      <section class="page-frame">
        <component :is="currentComponent" :key="activeView" />
      </section>
    </main>

    <div class="toast-stack" aria-live="polite" aria-relevant="additions">
      <div v-for="item in toastItems" :key="item.id" class="toast" :class="item.tone">
        <span class="toast-dot"></span>{{ item.message }}
      </div>
    </div>
  </div>
</template>

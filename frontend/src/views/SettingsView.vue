<script setup>
import { inject, ref, watch } from 'vue';

const api = inject('api');
const apiToken = inject('apiToken');
const saveToken = inject('saveToken');
const refreshConnection = inject('refreshConnection');
const notify = inject('notify');
const draft = ref(apiToken.value);
const visible = ref(false);
const saving = ref(false);
const saved = ref(false);
const endpoint = window.location.origin;
const runtimeLoading = ref(false);
const runtimeSaving = ref(false);
const runtimeError = ref('');
const runtime = ref(null);
const runtimeDraft = ref({
  followupAutomationEnabled: false,
  followupScanIntervalMinutes: 30,
  followupAutoProcess: false,
});

const intervalOptions = [5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1440];

watch(apiToken, (value) => {
  draft.value = value;
});

async function submit() {
  saving.value = true;
  saved.value = false;
  try {
    await saveToken(draft.value);
    await loadRuntimeSettings();
    saved.value = true;
    notify(draft.value ? '令牌已保存到当前浏览器。' : '已清除本地令牌。', draft.value ? 'success' : 'info');
  } finally {
    saving.value = false;
  }
}

async function recheck() {
  await refreshConnection();
  notify('连接状态已刷新。', 'info');
}

function setRuntime(response) {
  runtime.value = response;
  runtimeDraft.value = { ...response.settings };
  runtimeError.value = '';
}

async function loadRuntimeSettings() {
  runtimeLoading.value = true;
  runtimeError.value = '';
  try {
    setRuntime(await api.request('/api/settings/runtime'));
  } catch (error) {
    runtimeError.value = error.status === 401
      ? '先填写并保存有效的 API 访问令牌，再读取服务端设置。'
      : error.message || '读取运行设置失败。';
  } finally {
    runtimeLoading.value = false;
  }
}

async function saveRuntimeSettings() {
  const current = runtime.value?.settings;
  const willEnableAutomaticWrites = runtimeDraft.value.followupAutoProcess
    && !current?.followupAutoProcess;
  const willStartAutomation = runtimeDraft.value.followupAutomationEnabled
    && !current?.followupAutomationEnabled;
  if (willEnableAutomaticWrites && !window.confirm(
    '自动处理会让定时追更任务通过当前存储插件写入媒体文件。确认已检查分享来源、存储位置和账号授权后继续？',
  )) return;
  if (willStartAutomation && runtimeDraft.value.followupAutoProcess
      && !willEnableAutomaticWrites && !window.confirm(
        '启用调度后会立即运行一次追更扫描，并按自动处理设置写入媒体。确认继续？',
      )) return;

  runtimeSaving.value = true;
  runtimeError.value = '';
  try {
    setRuntime(await api.request('/api/settings/runtime', {
      method: 'PUT',
      body: runtimeDraft.value,
    }));
    notify('服务端追更设置已保存。');
  } catch (error) {
    runtimeError.value = error.message || '保存运行设置失败。';
    notify(runtimeError.value, 'error');
  } finally {
    runtimeSaving.value = false;
  }
}

async function resetRuntimeSettings() {
  const defaults = runtime.value?.defaults;
  const willStartAutomation = defaults?.followupAutomationEnabled;
  const willRunWithWrites = willStartAutomation && defaults?.followupAutoProcess;
  const prompt = willRunWithWrites
    ? '环境变量默认值会立即启动扫描、排队候选并自动处理媒体。确认你已检查存储位置和账号授权后恢复？'
    : willStartAutomation
      ? '环境变量默认值会立即启动扫描并排队符合条件的候选事件，但不会自动写入媒体。继续吗？'
      : '恢复后会删除数据库中的运行设置，并重新使用部署环境变量中的默认值。继续吗？';
  if (!window.confirm(prompt)) return;
  runtimeSaving.value = true;
  runtimeError.value = '';
  try {
    setRuntime(await api.request('/api/settings/runtime', { method: 'DELETE' }));
    notify('已恢复环境变量默认值。', 'info');
  } catch (error) {
    runtimeError.value = error.message || '恢复默认值失败。';
    notify(runtimeError.value, 'error');
  } finally {
    runtimeSaving.value = false;
  }
}

loadRuntimeSettings();
</script>

<template>
  <div class="view-stack settings-view">
    <div class="page-intro"><div><h2>连接你的追剧引擎服务。</h2><p>令牌用于浏览器访问受保护的 REST API。</p></div></div>
    <section class="settings-layout">
      <div class="settings-primary">
      <div class="panel settings-main-card">
        <div class="panel-heading"><div><h3>API 访问令牌</h3><p>服务端通过 API_ACCESS_TOKEN 配置访问令牌。</p></div><span class="settings-lock">⌑</span></div>
        <form class="form-stack" @submit.prevent="submit">
          <label class="field"><span>Bearer Token</span><div class="secret-input"><input v-model="draft" :type="visible ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="粘贴服务端配置的 API_ACCESS_TOKEN" /><button type="button" class="secret-toggle" @click="visible = !visible">{{ visible ? '隐藏' : '显示' }}</button></div><small>令牌仅存储在这个浏览器的 localStorage 中，并随请求发送给当前服务。</small></label>
          <div class="settings-current"><span class="status-led" :class="draft.trim() ? 'good' : 'muted'"></span><div><strong>{{ draft.trim() ? '已填写访问令牌' : '尚未填写访问令牌' }}</strong><small>目标服务：{{ endpoint }}</small></div></div>
          <div class="modal-actions settings-actions"><span v-if="saved" class="save-confirmation">✓ 已保存</span><button class="button button-quiet" type="button" :disabled="saving" @click="recheck">检查连接</button><button class="button button-primary" type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存并连接' }}</button></div>
        </form>
      </div>
      <div class="panel settings-main-card runtime-settings-card">
        <div class="panel-heading"><div><h3>追更自动化</h3><p>管理服务端的扫描周期与媒体写入行为。</p></div><span class="settings-lock">↻</span></div>
        <div v-if="runtimeLoading" class="settings-runtime-state">正在读取服务端设置…</div>
        <div v-else-if="runtimeError && !runtime" class="settings-runtime-state settings-runtime-error">
          <p>{{ runtimeError }}</p>
          <button class="button button-quiet" type="button" @click="loadRuntimeSettings">重试</button>
        </div>
        <form v-else class="form-stack" @submit.prevent="saveRuntimeSettings">
          <div class="settings-current"><span class="status-led" :class="runtime?.settings.followupAutomationEnabled ? 'good' : 'muted'"></span><div><strong>{{ runtime?.settings.followupAutomationEnabled ? '定时扫描已启用' : '定时扫描已关闭' }}</strong><small>{{ runtime?.source === 'database' ? '使用数据库中保存的设置' : '使用部署环境变量默认值' }}</small></div></div>
          <label class="settings-toggle"><input v-model="runtimeDraft.followupAutomationEnabled" type="checkbox" /><span><strong>启用定时扫描</strong><small>启用后立即扫描并排队符合条件的候选，之后按设定间隔执行。</small></span></label>
          <label class="field"><span>扫描间隔</span><select v-model.number="runtimeDraft.followupScanIntervalMinutes"><option v-for="minutes in intervalOptions" :key="minutes" :value="minutes">{{ minutes < 60 ? `${minutes} 分钟` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` }}</option></select><small>支持 5 分钟到 24 小时。扫描会使用已启用的资源搜索和存储插件。</small></label>
          <label class="settings-toggle settings-toggle-risk"><input v-model="runtimeDraft.followupAutoProcess" type="checkbox" /><span><strong>自动处理追更事件</strong><small>开启后，定时任务会转存选中的媒体并更新存储目录。新安装默认关闭。</small></span></label>
          <div v-if="runtimeError" class="settings-runtime-error">{{ runtimeError }}</div>
          <div class="modal-actions settings-actions"><span class="save-confirmation">{{ runtime?.source === 'database' ? '数据库设置' : '环境默认值' }}</span><button class="button button-quiet" type="button" :disabled="runtimeSaving" @click="resetRuntimeSettings">恢复环境默认值</button><button class="button button-primary" type="submit" :disabled="runtimeSaving || runtimeLoading">{{ runtimeSaving ? '正在保存…' : '保存运行设置' }}</button></div>
        </form>
      </div>
      </div>
      <aside class="settings-aside">
        <section class="panel settings-note"><div class="note-icon">i</div><h3>同源访问</h3><p>管理面板由 Drama Warden 服务提供，与 API 使用同一个地址。开发时 Vite 会将 /api 请求代理到本地后端。</p></section>
        <section class="panel settings-note"><div class="note-icon note-icon-warm">⌑</div><h3>保护你的令牌</h3><p>不要在共享设备上保存令牌。清除此处令牌不会更改服务端的 API_ACCESS_TOKEN。</p><button class="text-button" type="button" @click="draft = ''; submit()">清除本地令牌 <span>→</span></button></section>
        <section class="panel settings-note"><div class="note-icon note-icon-blue">⌘</div><h3>部署与插件凭据</h3><p>数据库连接、元数据密钥、插件路径和服务凭据仍通过环境变量配置。面板只保存追更扫描与自动处理选项，不会读取或回显密钥。</p></section>
      </aside>
    </section>
  </div>
</template>

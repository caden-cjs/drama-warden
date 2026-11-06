<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { errorMessage, formatDate, mediaTypeLabel, providerTitle } from '../lib/format.js';

const api = inject('api');
const notify = inject('notify');
const refreshConnection = inject('refreshConnection');
const shows = ref([]);
const plugins = ref([]);
const loading = ref(true);
const loadError = ref('');
const query = ref('');
const showCreate = ref(false);
const showStorageModal = ref(false);
const creating = ref(false);
const searchingMetadata = ref(false);
const linkingStorage = ref(false);
const metadataResults = ref([]);
const metadataProviders = ref([]);
const selectedMetadata = ref(null);
const metadataQuery = ref('');
const detailMetadataQuery = ref('');
const detailMetadataResults = ref([]);
const detailMetadataLoading = ref(false);
const linkingMetadata = ref(null);
const detail = ref(null);
const detailLoading = ref(false);
const storageScanId = ref(null);
const resourceQuery = ref('');
const resourceResults = ref([]);
const resourceProviders = ref([]);
const resourceLoading = ref(false);
const selectedCandidate = ref(null);
const followupPreview = ref(null);
const followupLoading = ref(false);
const queueing = ref(false);
const createForm = ref({ name: '', mediaType: 'tv', aliases: '' });
const storageForm = ref({ providerId: '', rootPath: '' });
let detailRequestId = 0;

const visibleShows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return shows.value;
  return shows.value.filter((show) =>
    show.name.toLowerCase().includes(needle)
      || (show.aliases || []).some((alias) => alias.toLowerCase().includes(needle)));
});
const storagePlugins = computed(() => plugins.value.filter((plugin) =>
  plugin.enabled && (plugin.storageContract || plugin.capabilities?.includes('listSharedFiles'))));
const discoveryStorage = computed(() => detail.value?.storages.find((storage) => storage.enabled) || null);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const [showResponse, pluginResponse] = await Promise.all([
      api.request('/api/shows'),
      api.request('/api/plugins'),
    ]);
    shows.value = showResponse.items || [];
    plugins.value = pluginResponse.items || [];
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createForm.value = { name: '', mediaType: 'tv', aliases: '' };
  metadataQuery.value = '';
  metadataResults.value = [];
  metadataProviders.value = [];
  selectedMetadata.value = null;
  showCreate.value = true;
}

async function searchMetadata() {
  const search = metadataQuery.value.trim();
  if (!search) return;
  searchingMetadata.value = true;
  selectedMetadata.value = null;
  try {
    const params = new URLSearchParams({ q: search, mediaType: createForm.value.mediaType, limit: '12' });
    const response = await api.request('/api/metadata/search?' + params.toString());
    metadataResults.value = response.results || [];
    metadataProviders.value = response.providers || [];
    if (!metadataResults.value.length) notify('没有找到匹配的元数据候选。', 'info');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    searchingMetadata.value = false;
  }
}

function selectMetadata(candidate) {
  selectedMetadata.value = candidate;
  if (!createForm.value.name.trim()) createForm.value.name = candidate.name || '';
}

async function createShow() {
  const name = createForm.value.name.trim();
  if (!name) return;
  creating.value = true;
  try {
    const body = {
      name,
      mediaType: createForm.value.mediaType,
      aliases: createForm.value.aliases.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean),
    };
    const response = await api.request('/api/shows', { method: 'POST', body });
    let identityWarning = '';
    if (selectedMetadata.value) {
      try {
        await api.request(`/api/shows/${response.show.id}/metadata-identities`, {
          method: 'POST',
          body: {
            providerId: selectedMetadata.value.providerId,
            externalId: selectedMetadata.value.externalId,
            mediaType: selectedMetadata.value.mediaType,
            linkedBy: 'web-ui',
          },
        });
      } catch (error) {
        identityWarning = `节目已建立，但元数据关联未完成：${errorMessage(error)}`;
      }
    }
    showCreate.value = false;
    await load();
    if (identityWarning) notify(identityWarning, 'warning');
    else notify(selectedMetadata.value ? '节目已建立并关联元数据。' : '节目已添加。');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    creating.value = false;
  }
}

async function openDetails(show) {
  const requestId = ++detailRequestId;
  detailLoading.value = true;
  resourceResults.value = [];
  followupPreview.value = null;
  selectedCandidate.value = null;
  detailMetadataResults.value = [];
  detailMetadataQuery.value = show.name;
  try {
    const [showResponse, storageResponse] = await Promise.all([
      api.request(`/api/shows/${show.id}`),
      api.request(`/api/shows/${show.id}/storages`),
    ]);
    if (requestId !== detailRequestId) return;
    detail.value = {
      show: showResponse.show,
      identities: showResponse.metadataIdentities || [],
      storages: storageResponse.items || [],
    };
    resourceQuery.value = show.name;
    storageForm.value = { providerId: storagePlugins.value[0]?.id || '', rootPath: `/shows/${show.name.replaceAll('/', '-')}` };
  } catch (error) {
    if (requestId === detailRequestId) notify(errorMessage(error), 'error');
  } finally {
    if (requestId === detailRequestId) detailLoading.value = false;
  }
}

function closeDetails() {
  detailRequestId += 1;
  detail.value = null;
  detailLoading.value = false;
}

async function searchDetailMetadata() {
  const search = detailMetadataQuery.value.trim();
  if (!search || !detail.value) return;
  detailMetadataLoading.value = true;
  try {
    const params = new URLSearchParams({ q: search, mediaType: detail.value.show.mediaType, limit: '12' });
    const response = await api.request('/api/metadata/search?' + params.toString());
    detailMetadataResults.value = response.results || [];
    if (!detailMetadataResults.value.length) notify('没有找到匹配的元数据候选。', 'info');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    detailMetadataLoading.value = false;
  }
}

async function linkDetailMetadata(candidate) {
  if (!detail.value) return;
  linkingMetadata.value = candidate;
  try {
    await api.request(`/api/shows/${detail.value.show.id}/metadata-identities`, {
      method: 'POST',
      body: {
        providerId: candidate.providerId,
        externalId: candidate.externalId,
        mediaType: candidate.mediaType,
        linkedBy: 'web-ui',
      },
    });
    await refreshDetail();
    notify(`已关联 ${candidate.providerId} 元数据。`);
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    linkingMetadata.value = null;
  }
}

async function refreshDetail() {
  if (detail.value) await openDetails(detail.value.show);
}

async function addStorage() {
  if (!detail.value || !storageForm.value.providerId || !storageForm.value.rootPath.trim()) return;
  linkingStorage.value = true;
  try {
    await api.request(`/api/shows/${detail.value.show.id}/storages`, {
      method: 'POST',
      body: { providerId: storageForm.value.providerId, rootPath: storageForm.value.rootPath.trim() },
    });
    showStorageModal.value = false;
    await refreshDetail();
    notify('存储位置已保存。');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    linkingStorage.value = false;
  }
}

async function scanStorage(storage) {
  storageScanId.value = storage.id;
  try {
    const result = await api.request(`/api/shows/${detail.value.show.id}/storages/${storage.id}/scan`, { method: 'POST' });
    const count = result.assetCount ?? result.assetsSeen ?? result.assets?.length;
    notify(count == null ? '存储扫描完成。' : `扫描完成，读取到 ${count} 个媒体资产。`);
    await refreshDetail();
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    storageScanId.value = null;
  }
}

async function searchResources(storageId) {
  resourceLoading.value = true;
  selectedCandidate.value = null;
  followupPreview.value = null;
  try {
    const response = await api.request(`/api/shows/${detail.value.show.id}/resources/search`, {
      method: 'POST',
      body: { storageId, query: resourceQuery.value.trim() || detail.value.show.name, limit: 10 },
    });
    resourceResults.value = response.results || [];
    resourceProviders.value = response.providers || [];
    if (!resourceResults.value.length) notify('没有找到资源候选。', 'info');
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    resourceLoading.value = false;
  }
}

async function previewCandidate(candidate, storageId) {
  selectedCandidate.value = candidate;
  followupPreview.value = null;
  followupLoading.value = true;
  try {
    const response = await api.request(`/api/shows/${detail.value.show.id}/followup/preview`, {
      method: 'POST',
      body: { storageId, shareUrl: candidate.shareUrl, shareTitle: candidate.title || '' },
    });
    followupPreview.value = response.preview;
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    followupLoading.value = false;
  }
}

async function queueFollowup() {
  if (!detail.value || !selectedCandidate.value || !followupPreview.value?.eligible) return;
  const storageId = followupPreview.value.storage?.id;
  if (!storageId) return;
  queueing.value = true;
  try {
    const response = await api.request(`/api/shows/${detail.value.show.id}/followup/queue`, {
      method: 'POST',
      body: {
        storageId,
        shareUrl: selectedCandidate.value.shareUrl,
        shareTitle: selectedCandidate.value.title || '',
      },
    });
    if (response.queued) {
      notify('候选已加入追更事件队列；媒体尚未转存。');
      closeDetails();
      await refreshConnection();
    } else {
      notify(response.preview?.reason || '该候选目前无法加入队列。', 'warning');
    }
  } catch (error) {
    notify(errorMessage(error), 'error');
  } finally {
    queueing.value = false;
  }
}

function startAddStorage() {
  if (!storagePlugins.value.length) {
    notify('没有已启用的存储插件，请先配置并启用存储 provider。', 'warning');
    return;
  }
  storageForm.value.providerId = storagePlugins.value[0].id;
  showStorageModal.value = true;
}

onMounted(load);
</script>

<template>
  <div class="view-stack">
    <div class="page-intro">
      <div><h2>管理你的追更清单。</h2><p>维护节目、元数据来源和媒体库位置。</p></div>
      <button class="button button-primary" type="button" @click="openCreate"><span>＋</span> 添加节目</button>
    </div>

    <section class="panel toolbar-panel">
      <div class="search-field"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索节目或别名" /></div>
      <div class="toolbar-actions"><span class="subtle-count">{{ visibleShows.length }} 部节目</span><button class="icon-button small" type="button" title="刷新节目列表" @click="load">⟳</button></div>
    </section>

    <div v-if="loadError" class="inline-alert error-alert"><span class="alert-symbol">!</span><div><strong>节目列表加载失败</strong><p>{{ loadError }}</p></div></div>
    <div v-if="loading" class="loading-grid"><div v-for="index in 4" :key="index" class="skeleton-card"></div></div>
    <div v-else-if="!visibleShows.length" class="panel empty-state shows-empty">
      <div class="empty-illustration">▣</div><strong>{{ query ? '没有匹配的节目' : '节目库还是空的' }}</strong>
      <p>{{ query ? '换一个名称或别名试试。' : '添加节目后，关联元数据并配置一个存储位置。' }}</p>
      <button v-if="!query" class="button button-primary" type="button" @click="openCreate">添加第一部节目</button>
    </div>
    <div v-else class="show-grid">
      <button v-for="show in visibleShows" :key="show.id" class="show-card" type="button" @click="openDetails(show)">
        <div class="show-card-top"><div class="poster-placeholder"><span>{{ (show.name || '?').slice(0, 1) }}</span></div><span class="show-type">{{ mediaTypeLabel(show.mediaType) }}</span></div>
        <div class="show-card-copy"><h3>{{ show.name }}</h3><div v-if="show.aliases?.length" class="show-alias">{{ show.aliases.slice(0, 2).join(' · ') }}</div><div class="show-card-footer"><span class="status-dot" :class="show.finished ? 'finished' : 'watching'"></span>{{ show.finished ? '已完结' : '追更中' }}<span class="show-id">#{{ show.id }}</span></div></div>
        <span class="show-arrow" aria-hidden="true">↗</span>
      </button>
    </div>

    <Teleport to="body">
      <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
        <section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="create-show-title">
          <div class="modal-heading"><div><span class="modal-kicker">节目库 / 新建</span><h2 id="create-show-title">添加节目</h2><p>选择元数据候选可以自动带入节目名称并建立来源关联。</p></div><button class="icon-button" type="button" aria-label="关闭" @click="showCreate = false">×</button></div>
          <form class="form-stack" @submit.prevent="createShow">
            <div class="form-row two-columns"><label class="field"><span>节目名称</span><input v-model="createForm.name" required maxlength="255" placeholder="例如：星际牛仔" /></label><label class="field"><span>媒体类型</span><select v-model="createForm.mediaType"><option value="tv">剧集</option><option value="movie">电影</option></select></label></div>
            <label class="field"><span>别名 <small>选填，用逗号分隔</small></span><input v-model="createForm.aliases" placeholder="英文名、其他译名" /></label>
            <div class="section-rule"><span>元数据关联</span></div>
            <div class="inline-search"><input v-model="metadataQuery" placeholder="搜索 TMDB / TVmaze" @keydown.enter.prevent="searchMetadata" /><button class="button button-secondary" type="button" :disabled="searchingMetadata || !metadataQuery.trim()" @click="searchMetadata">{{ searchingMetadata ? '搜索中…' : '搜索' }}</button></div>
            <div v-if="metadataProviders.length" class="provider-summary">搜索来源：{{ metadataProviders.map((item) => item.id || item.providerId || item).join(' · ') }}</div>
            <div v-if="metadataResults.length" class="metadata-results">
              <button v-for="candidate in metadataResults" :key="`${candidate.providerId}-${candidate.externalId}`" class="metadata-result" :class="{ selected: selectedMetadata === candidate }" type="button" @click="selectMetadata(candidate)">
                <span class="metadata-radio">{{ selectedMetadata === candidate ? '✓' : '' }}</span>
                <span class="metadata-result-main"><strong>{{ candidate.name }}</strong><small>{{ candidate.originalName && candidate.originalName !== candidate.name ? candidate.originalName + ' · ' : '' }}{{ candidate.year || candidate.firstAirDate || '年份未知' }}</small></span>
                <span class="provider-tag">{{ candidate.providerId }}</span>
              </button>
            </div>
            <div v-else class="helper-panel">未选择候选时仍可先添加节目，之后再通过其他 API 或管理工具关联元数据。</div>
            <div class="modal-actions"><button class="button button-quiet" type="button" @click="showCreate = false">取消</button><button class="button button-primary" type="submit" :disabled="creating || !createForm.name.trim()">{{ creating ? '正在保存…' : selectedMetadata ? '创建并关联' : '创建节目' }}</button></div>
          </form>
        </section>
      </div>

      <div v-if="detail || detailLoading" class="modal-backdrop detail-backdrop" @click.self="closeDetails">
        <section v-if="detail" class="detail-drawer" role="dialog" aria-modal="true" :aria-labelledby="`show-title-${detail.show.id}`">
          <div class="detail-heading"><button class="icon-button" type="button" aria-label="关闭" @click="closeDetails">←</button><div class="detail-heading-copy"><span class="modal-kicker">节目详情 / #{{ detail.show.id }}</span><h2 :id="`show-title-${detail.show.id}`">{{ detail.show.name }}</h2></div><button class="icon-button" type="button" aria-label="刷新详情" @click="refreshDetail">⟳</button></div>
          <div class="detail-scroll">
            <div class="detail-summary-card"><div class="poster-placeholder poster-large"><span>{{ detail.show.name.slice(0, 1) }}</span></div><div><span class="status-dot" :class="detail.show.finished ? 'finished' : 'watching'"></span><strong>{{ detail.show.finished ? '已完结' : '追更中' }}</strong><p>{{ mediaTypeLabel(detail.show.mediaType) }} · 添加于 {{ formatDate(detail.show.createdAt) }}</p><small v-if="detail.show.aliases?.length">别名：{{ detail.show.aliases.join('、') }}</small></div></div>
            <section class="detail-section"><div class="section-heading"><div><h3>元数据来源</h3><p>用于确认季集清单和缺集计划</p></div><span class="subtle-count">{{ detail.identities.length }} 个</span></div><div v-if="!detail.identities.length" class="detail-empty">尚未关联元数据。搜索节目候选并明确选择对应的来源。</div><div v-else class="identity-list"><div v-for="identity in detail.identities" :key="identity.id" class="identity-row"><span class="identity-logo">{{ identity.providerId.slice(0, 1).toUpperCase() }}</span><div><strong>{{ identity.providerId }}</strong><small>{{ identity.mediaType }} · 外部 ID {{ identity.externalId }}</small></div><span class="identity-date">{{ formatDate(identity.linkedAt) }}</span></div></div><div class="inline-search detail-metadata-search"><input v-model="detailMetadataQuery" placeholder="搜索其他元数据来源" @keydown.enter.prevent="searchDetailMetadata" /><button class="button button-secondary" type="button" :disabled="detailMetadataLoading || !detailMetadataQuery.trim()" @click="searchDetailMetadata">{{ detailMetadataLoading ? '搜索中…' : '搜索' }}</button></div><div v-if="detailMetadataResults.length" class="metadata-results detail-candidates"><div v-for="candidate in detailMetadataResults" :key="`${candidate.providerId}-${candidate.externalId}`" class="metadata-result"><span class="metadata-result-main"><strong>{{ candidate.name }}</strong><small>{{ candidate.providerId }} · {{ candidate.year || candidate.firstAirDate || '年份未知' }}</small></span><button class="button button-quiet button-small" type="button" :disabled="linkingMetadata === candidate" @click="linkDetailMetadata(candidate)">{{ linkingMetadata === candidate ? '关联中…' : '关联' }}</button></div></div></section>
            <section class="detail-section"><div class="section-heading"><div><h3>媒体库位置</h3><p>扫描会读取目录并同步集资产</p></div><button class="button button-secondary button-small" type="button" @click="startAddStorage">＋ 添加位置</button></div><div v-if="!detail.storages.length" class="detail-empty">还没有配置存储位置。启用本地存储插件后，可以添加一个媒体目录。</div><div v-else class="storage-list"><div v-for="storage in detail.storages" :key="storage.id" class="storage-row"><div class="storage-icon">▤</div><div class="storage-copy"><strong>{{ storage.rootPath }}</strong><small>{{ storage.providerId }} · {{ storage.enabled ? '已启用' : '已停用' }}</small></div><button class="button button-quiet button-small" type="button" :disabled="storageScanId === storage.id || !storage.enabled" @click="scanStorage(storage)">{{ storageScanId === storage.id ? '扫描中…' : '扫描目录' }}</button></div></div></section>
            <section v-if="detail.show.mediaType === 'tv'" class="detail-section followup-section"><div class="section-heading"><div><h3>资源候选</h3><p>搜索并预览，不会直接转存媒体</p></div></div><div v-if="!detail.storages.length" class="detail-empty">先添加存储位置，再搜索资源候选。</div><div v-else-if="!discoveryStorage" class="detail-empty">当前存储位置都已停用，请先在服务端启用一个位置。</div><template v-else><div class="inline-search resource-search"><input v-model="resourceQuery" placeholder="资源搜索关键词" @keydown.enter.prevent="searchResources(discoveryStorage.id)" /><button class="button button-secondary" type="button" :disabled="resourceLoading" @click="searchResources(discoveryStorage.id)">{{ resourceLoading ? '搜索中…' : '搜索资源' }}</button></div><div v-if="resourceProviders.length" class="provider-summary">{{ resourceProviders.map((item) => `${item.providerId}${item.ok ? '' : '（失败）'}`).join(' · ') }}</div><div v-if="resourceResults.length" class="resource-results"><article v-for="(candidate, index) in resourceResults" :key="candidate.sourceId || index" class="resource-card" :class="{ chosen: selectedCandidate === candidate }"><div><strong>{{ candidate.title || '未命名资源' }}</strong><small>{{ candidate.providerId }} · {{ candidate.preview?.eligible ? '预览可追更' : candidate.preview?.reason || '需要复核' }}</small></div><button class="button button-quiet button-small" type="button" :disabled="followupLoading" @click="previewCandidate(candidate, discoveryStorage.id)">{{ selectedCandidate === candidate && followupLoading ? '预览中…' : '预览' }}</button></article></div><div v-if="followupPreview" class="preview-card" :class="followupPreview.eligible ? 'preview-good' : 'preview-muted'"><div class="preview-head"><strong>{{ followupPreview.eligible ? '确认到可追集内容' : '当前无法追更' }}</strong><span>{{ followupPreview.reason || '计划已生成' }}</span></div><p v-if="followupPreview.plan">S{{ String(followupPreview.plan.seasonNumber).padStart(2, '0') }} · 本次选择 {{ followupPreview.plan.saveBatch?.length || 0 }} 集<span v-if="followupPreview.plan.deferredCount">，另有 {{ followupPreview.plan.deferredCount }} 集留待后续</span></p><div v-if="followupPreview.plan?.saveBatch?.length" class="episode-chips"><span v-for="file in followupPreview.plan.saveBatch" :key="file.fileId || file.id || file.episodeNumber">E{{ String(file.episodeNumber || file.episode || '?').padStart(2, '0') }}</span></div><button v-if="followupPreview.eligible" class="button button-primary button-full" type="button" :disabled="queueing" @click="queueFollowup">{{ queueing ? '正在加入…' : '加入追更队列' }}</button><small v-if="followupPreview.eligible" class="helper-note">加入队列只创建待处理事件，不会写入媒体文件。</small></div></template></section><section v-else class="detail-section"><div class="section-heading"><div><h3>资源候选</h3><p>当前资源追更流程针对剧集设计</p></div></div><div class="detail-empty">电影的资源追踪和存储流程尚未实现。</div></section>
          </div>
        </section>
        <section v-else class="modal loading-modal"><div class="spinner"></div><strong>正在加载节目详情</strong></section>
      </div>

      <div v-if="showStorageModal" class="modal-backdrop nested-backdrop" @click.self="showStorageModal = false">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="storage-title"><div class="modal-heading"><div><span class="modal-kicker">{{ detail?.show.name }} / 存储</span><h2 id="storage-title">添加媒体库位置</h2><p>位置使用对应存储插件的路径语义。</p></div><button class="icon-button" type="button" aria-label="关闭" @click="showStorageModal = false">×</button></div><form class="form-stack" @submit.prevent="addStorage"><label class="field"><span>存储插件</span><select v-model="storageForm.providerId"><option v-for="plugin in storagePlugins" :key="plugin.id" :value="plugin.id">{{ providerTitle(plugin) }}</option></select></label><label class="field"><span>目录路径</span><input v-model="storageForm.rootPath" required maxlength="600" placeholder="/shows/节目名" /><small v-if="storageForm.providerId === 'local-storage'">本地存储要求以 / 开头，并且不能是根目录。</small></label><div class="modal-actions"><button class="button button-quiet" type="button" @click="showStorageModal = false">取消</button><button class="button button-primary" type="submit" :disabled="linkingStorage">{{ linkingStorage ? '保存中…' : '保存位置' }}</button></div></form></section>
      </div>
    </Teleport>
  </div>
</template>

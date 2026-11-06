export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function statusLabel(status) {
  return ({
    pending: '待处理',
    processing: '处理中',
    processed: '已完成',
    skipped: '已跳过',
    failed: '失败',
  })[status] || status || '未知';
}

export function mediaTypeLabel(type) {
  return type === 'movie' ? '电影' : '剧集';
}

export function providerTitle(provider) {
  return provider?.label || provider?.name || provider?.id || '未命名插件';
}

export function eventTitle(event) {
  const payload = event?.payload || {};
  return payload.shareTitle || payload.title || event?.kind || '追更事件';
}

export function errorMessage(error) {
  return error?.message || '请求失败，请稍后重试';
}

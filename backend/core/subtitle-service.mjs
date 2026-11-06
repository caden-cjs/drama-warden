function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(field + ' must be a positive integer');
  return id;
}

export function createSubtitleService({ shows, episodes, repository, listPlugins } = {}) {
  if (!shows || !episodes || !repository || typeof listPlugins !== 'function') {
    throw new TypeError('show, episode, subtitle repository, and plugin services are required');
  }

  function storagePlugin(providerId) {
    return listPlugins({
      kind: 'storage-provider',
      capability: 'writeSidecar',
      enabledOnly: true,
    }).find((plugin) => plugin.id === providerId) || null;
  }

  return Object.freeze({
    async queue(input = {}) {
      const showId = positiveId(input.showId, 'showId');
      const storageId = positiveId(input.storageId, 'storageId');
      const show = await shows.getById(showId);
      if (!show) throw new Error('show ' + showId + ' does not exist');
      const storages = await episodes.listShowStorages(showId);
      const storage = storages.find((item) => item.id === storageId && item.enabled);
      if (!storage) throw new Error('enabled storage does not exist for this show');
      if (!storagePlugin(storage.providerId)) {
        const error = new Error('storage provider does not support subtitle sidecar writes');
        error.code = 'SIDECAR_WRITE_UNSUPPORTED';
        error.status = 422;
        throw error;
      }
      const job = await repository.create({
        showId,
        storageId,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        languages: input.languages,
      });
      return { job, queued: job.status === 'pending' };
    },

    async list(options) {
      return repository.list(options);
    },

    async get(id) {
      return repository.getById(id);
    },

    async retry(idValue) {
      const id = positiveId(idValue, 'id');
      const context = await repository.getContext(id);
      if (!context) throw new Error('subtitle job ' + id + ' does not exist');
      if (!context.storage || !storagePlugin(context.storage.providerId)) {
        const error = new Error('storage provider does not support subtitle sidecar writes');
        error.code = 'SIDECAR_WRITE_UNSUPPORTED';
        error.status = 422;
        throw error;
      }
      return repository.retryFailed(id);
    },
  });
}

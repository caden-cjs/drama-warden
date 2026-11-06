import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceDiscoveryService } from '../core/resource-discovery-service.mjs';

test('resource discovery passes the destination storage provider to a registered resource plugin', async () => {
  let invocation;
  let previewRequest;
  const service = createResourceDiscoveryService({
    shows: {
      getById: async () => ({ id: 1, name: '示例剧', aliases: ['别名'], mediaType: 'tv' }),
    },
    episodes: {
      getStorageById: async () => ({
        id: 2,
        showId: 1,
        providerId: 'pan115',
        enabled: true,
      }),
      listStorageEpisodes: async () => [],
    },
    listPlugins: () => [{ id: 'community-catalog' }],
    invoke: async (pluginId, request) => {
      invocation = { pluginId, request };
      return {
        items: [{ shareUrl: 'https://shares.example/item', title: '示例剧 S01E01' }],
        truncated: false,
      };
    },
    followup: {
      previewShare: async (request) => {
        previewRequest = request;
        return { eligible: true };
      },
    },
  });

  const result = await service.searchForShow({ showId: 1, storageId: 2 });

  assert.equal(invocation.pluginId, 'community-catalog');
  assert.equal(invocation.request.capability, 'search');
  assert.equal(invocation.request.input.storageProvider, 'pan115');
  assert.equal(previewRequest.shareUrl, 'https://shares.example/item');
  assert.equal(result.results[0].providerId, 'community-catalog');
  assert.equal(result.results[0].preview.eligible, true);
});

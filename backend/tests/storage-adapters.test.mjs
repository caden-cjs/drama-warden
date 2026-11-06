import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuarkStoragePlugin } from '../plugins/quark/index.mjs';
import { createPan115ShareLister } from '../plugins/pan115/cli.mjs';
import { createPan115StoragePlugin } from '../plugins/pan115/index.mjs';

const shareUrl = 'https://share.example/s/release-fixture';

test('Quark storage adapter saves only current selected file IDs and rejects stale selections', async () => {
  const calls = [];
  const selectedFile = {
    fid: 'quark-file-17',
    name: 'Show.S01E01.1080p.mkv',
    path: 'Season 01',
    size: 1200,
    mtime: 1700000000,
  };
  const plugin = createQuarkStoragePlugin({
    async quarkShareFiles(requestUrl) {
      assert.equal(requestUrl, shareUrl);
      return [selectedFile];
    },
    async quarkSave(...args) {
      calls.push(args);
      return {
        ok: true,
        savedCount: 1,
        taskPoll: { completed: true, status: 'finished' },
        verified: true,
      };
    },
  });

  const listing = await plugin.invoke({
    capability: 'listSharedFiles',
    input: { shareUrl },
  });
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].name, selectedFile.name);
  assert.equal(listing.files[0].path, 'Season 01/' + selectedFile.name);
  assert.notEqual(listing.files[0].id, selectedFile.fid);
  assert.equal(JSON.stringify(listing).includes(selectedFile.fid), false);

  const saved = await plugin.invoke({
    capability: 'save',
    input: {
      shareUrl,
      destinationPath: '/Library/Show/Season 01',
      selection: [listing.files[0]],
    },
  });
  assert.deepEqual(calls, [[
    shareUrl,
    '/Library/Show/Season 01',
    { fidList: ['quark-file-17'] },
  ]]);
  assert.deepEqual(saved, {
    ok: true,
    savedCount: 1,
    completed: true,
    verified: true,
    status: 'finished',
  });

  await assert.rejects(plugin.invoke({
    capability: 'save',
    input: {
      shareUrl,
      destinationPath: '/Library/Show/Season 01',
      selection: [{ ...listing.files[0], id: 'stale-selection' }],
    },
  }), (error) => error.code === 'INVALID_SHARE_SELECTION');
  assert.equal(calls.length, 1);
  await assert.rejects(plugin.invoke({
    capability: 'list',
    input: { path: '/Library/../private' },
  }), (error) => error.code === 'INVALID_STORAGE_PATH');
});

test('115 storage adapter translates selected files to path-based CLI references', async () => {
  const calls = [];
  const listingCalls = [];
  const pan115ShareFiles = createPan115ShareLister({
    async available() { return true; },
    async run(args) {
      listingCalls.push(args);
      return args.at(-1) === '/'
        ? [{ ID: '115-dir-28', Name: 'season', Type: 'dir' }]
        : [{
          ID: '115-file-29',
          Name: 'Show.S01E02.1080p.mkv',
          Type: 'file',
          Size: 2200,
          Modified: '2026-10-30T12:00:00Z',
        }];
    },
  });
  const plugin = createPan115StoragePlugin({
    adapter: {
      pan115ShareFiles,
      async pan115Save(...args) {
        calls.push(args);
        return { ok: true, savedCount: 1 };
      },
    },
  });

  const listing = await plugin.invoke({
    capability: 'listSharedFiles',
    input: { shareUrl },
  });
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].name, 'Show.S01E02.1080p.mkv');
  assert.equal(listing.files[0].path, 'season/Show.S01E02.1080p.mkv');
  assert.notEqual(listing.files[0].id, '115-file-29');
  assert.equal(JSON.stringify(listing).includes('115-file-29'), false);
  assert.deepEqual(listingCalls.map((args) => args.at(-1)), ['/', 'season']);

  const saved = await plugin.invoke({
    capability: 'save',
    input: {
      shareUrl,
      destinationPath: '/Library/Show/Season 01',
      selection: [listing.files[0]],
    },
  });
  assert.deepEqual(calls, [[
    shareUrl,
    '/Library/Show/Season 01',
    {
      selection: [{
        id: '115-file-29',
        path: 'season/Show.S01E02.1080p.mkv',
        name: 'Show.S01E02.1080p.mkv',
      }],
    },
  ]]);
  assert.deepEqual(saved, {
    ok: true,
    savedCount: 1,
    completed: true,
    verified: null,
    status: null,
  });

  await assert.rejects(plugin.invoke({
    capability: 'save',
    input: {
      shareUrl,
      destinationPath: '/Library/Show/Season 01',
      selection: [{ ...listing.files[0], id: 'stale-selection' }],
    },
  }), (error) => error.code === 'INVALID_SHARE_SELECTION');
  assert.equal(calls.length, 1);
  await assert.rejects(plugin.invoke({
    capability: 'mkdir',
    input: { path: '/Library/../private' },
  }), (error) => error.code === 'INVALID_STORAGE_PATH');
});

test('Quark and 115 adapters enforce their distinct remove modes before calling the CLI', async () => {
  const quarkCalls = [];
  const quark = createQuarkStoragePlugin({
    async quarkDelete(targetPath) {
      quarkCalls.push(targetPath);
      return { ok: true };
    },
  });
  const pan115Calls = [];
  const pan115 = createPan115StoragePlugin({
    adapter: {
      async pan115Delete(targetPath, options) {
        pan115Calls.push({ targetPath, options });
      },
    },
  });

  await assert.rejects(quark.invoke({
    capability: 'remove',
    input: { path: '/Library/Show', mode: 'permanent' },
  }), (error) => error.code === 'UNSUPPORTED_REMOVE_MODE');
  assert.deepEqual(quarkCalls, []);
  await quark.invoke({
    capability: 'remove',
    input: { path: '/Library/Show', mode: 'recycle' },
  });
  assert.deepEqual(quarkCalls, ['/Library/Show']);

  await assert.rejects(pan115.invoke({
    capability: 'remove',
    input: { path: '/Library/Show', mode: 'recycle' },
  }), (error) => error.code === 'UNSUPPORTED_REMOVE_MODE');
  assert.deepEqual(pan115Calls, []);
  await pan115.invoke({
    capability: 'remove',
    input: { path: '/Library/Show', mode: 'permanent' },
  });
  assert.deepEqual(pan115Calls, [{ targetPath: '/Library/Show', options: {} }]);
});

test('Quark and 115 clean refuse incomplete or filtered listings before deleting anything', async () => {
  for (const marker of ['truncated', 'recent']) {
    const quarkDeletes = [];
    const quark = createQuarkStoragePlugin({
      async quarkList() {
        return {
          files: [{ name: 'candidate.mkv', isDir: false }],
          truncated: marker === 'truncated',
          recent: marker === 'recent',
        };
      },
      async quarkDelete(targetPath) { quarkDeletes.push(targetPath); },
    });
    await assert.rejects(quark.invoke({
      capability: 'clean',
      input: { path: '/Library/Show', mode: 'recycle', options: { deleteDuplicates: true, keepFiles: ['keep'] } },
    }), (error) => error.code === 'INCOMPLETE_STORAGE_LISTING');
    assert.deepEqual(quarkDeletes, []);

    const pan115Deletes = [];
    const pan115 = createPan115StoragePlugin({
      adapter: {
        async pan115List() {
          return {
            files: [{ name: 'candidate.mkv', isDir: false }],
            truncated: marker === 'truncated',
            recent: marker === 'recent',
          };
        },
        async pan115Delete(targetPath) { pan115Deletes.push(targetPath); },
      },
    });
    await assert.rejects(pan115.invoke({
      capability: 'clean',
      input: { path: '/Library/Show', mode: 'permanent', options: { deleteDuplicates: true, keepFiles: ['keep'] } },
    }), (error) => error.code === 'INCOMPLETE_STORAGE_LISTING');
    assert.deepEqual(pan115Deletes, []);
  }
});

test('cloud storage clean and remove operations reject the storage root', async () => {
  const quarkCalls = [];
  const quark = createQuarkStoragePlugin({
    async quarkList() { quarkCalls.push('list'); return { files: [], truncated: false }; },
    async quarkDelete(targetPath) { quarkCalls.push(targetPath); },
  });
  await assert.rejects(quark.invoke({
    capability: 'clean',
    input: { path: '/', mode: 'recycle' },
  }), (error) => error.code === 'INVALID_STORAGE_PATH');
  assert.deepEqual(quarkCalls, []);

  const pan115Calls = [];
  const pan115 = createPan115StoragePlugin({
    adapter: {
      async pan115List() { pan115Calls.push('list'); return { files: [], truncated: false }; },
      async pan115Delete(targetPath) { pan115Calls.push(targetPath); },
    },
  });
  await assert.rejects(pan115.invoke({
    capability: 'clean',
    input: { path: '/', mode: 'permanent' },
  }), (error) => error.code === 'INVALID_STORAGE_PATH');
  await assert.rejects(pan115.invoke({
    capability: 'remove',
    input: { path: '/', mode: 'permanent' },
  }), (error) => error.code === 'INVALID_STORAGE_PATH');
  assert.deepEqual(pan115Calls, []);
});

test('complete storage listings apply clean filters through provider-specific removal policies', async () => {
  const listing = {
    files: [
      { name: 'Season 02', isDir: true },
      { name: 'keep.mkv', isDir: false },
      { name: 'remove.mkv', isDir: false },
    ],
    truncated: false,
    recent: false,
  };
  const options = { deleteSubdirs: true, deleteDuplicates: true, keepFiles: ['keep'] };
  const expected = {
    kept: ['keep.mkv'],
    keptDirs: [],
    deleted: [
      { name: 'Season 02', type: 'dir' },
      { name: 'remove.mkv', type: 'file' },
    ],
  };

  const quarkDeletes = [];
  const quark = createQuarkStoragePlugin({
    async quarkList() { return listing; },
    async quarkDelete(targetPath) { quarkDeletes.push(targetPath); },
  });
  const quarkResult = await quark.invoke({
    capability: 'clean',
    input: { path: '/Library/Show', mode: 'recycle', options },
  });
  assert.deepEqual(quarkDeletes, ['/Library/Show/Season 02', '/Library/Show/remove.mkv']);
  assert.deepEqual(quarkResult, { ok: true, mode: 'recycle', path: '/Library/Show', ...expected });

  const pan115Deletes = [];
  const pan115 = createPan115StoragePlugin({
    adapter: {
      async pan115List() { return listing; },
      async pan115Delete(targetPath, deleteOptions) { pan115Deletes.push({ targetPath, deleteOptions }); },
    },
  });
  const pan115Result = await pan115.invoke({
    capability: 'clean',
    input: { path: '/Library/Show', mode: 'permanent', options },
  });
  assert.deepEqual(pan115Deletes, [
    { targetPath: '/Library/Show/Season 02', deleteOptions: { recursive: true } },
    { targetPath: '/Library/Show/remove.mkv', deleteOptions: undefined },
  ]);
  assert.deepEqual(pan115Result, { ok: true, mode: 'permanent', path: '/Library/Show', ...expected });
});

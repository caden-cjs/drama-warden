import {
  METADATA_CAPABILITIES,
  PLUGIN_API_VERSION,
  PLUGIN_KINDS,
  RESOURCE_CAPABILITIES,
  STORAGE_CAPABILITIES,
  STORAGE_OPTIONAL_CAPABILITIES,
  STORAGE_REMOVE_MODES,
  SUBTITLE_CAPABILITIES,
  assertPlugin,
  defineMetadataPlugin,
  definePlugin,
  defineResourcePlugin,
  defineStoragePlugin,
  defineSubtitlePlugin,
  type CapabilityDomains,
  type ConfigField,
  type ConfigSchema,
  type JsonObject,
  type MetadataDetail,
  type MetadataDetailInput,
  type MetadataEpisode,
  type MetadataEpisodesInput,
  type MetadataCandidate,
  type MetadataSearchInput,
  type MetadataSeason,
  type PluginAction,
  type PluginConfig,
  type PluginContext,
  type PluginDefinition,
  type PluginFactory,
  type PluginKind,
  type PluginLifecycleOptions,
  type PluginManifest,
  type PluginManifestInput,
  type ResourceCandidate,
  type ResourceSearchInput,
  type ResourceSearchResult,
  type StorageActionMap,
  type StorageCapability,
  type StorageCleanInput,
  type StorageCleanOptions,
  type StorageContract,
  type StorageFileEntry,
  type StorageListInput,
  type StorageListOptions,
  type StorageListSharedFilesInput,
  type StorageListing,
  type StorageMoveInput,
  type StoragePathInput,
  type StorageRenameInput,
  type StorageRenameItem,
  type StorageRenameManyInput,
  type StorageRemoveInput,
  type StorageRemoveMode,
  type StorageRemoveModes,
  type StorageSaveInput,
  type StorageSaveResult,
  type StorageShareFile,
  type StorageSharedListing,
  type StorageWriteSidecarInput,
  type SubtitleCandidate,
  type SubtitleDownloadInput,
  type SubtitleDownloadResult,
  type SubtitleSearchInput,
} from '@drama-warden/plugin-sdk';

type PublicTypeExports = [
  CapabilityDomains,
  ConfigField,
  ConfigSchema,
  JsonObject,
  MetadataCandidate,
  MetadataDetail,
  MetadataDetailInput,
  MetadataEpisode,
  MetadataEpisodesInput,
  MetadataSearchInput,
  MetadataSeason,
  PluginAction,
  PluginConfig,
  PluginContext,
  PluginDefinition,
  PluginFactory,
  PluginKind,
  PluginLifecycleOptions,
  PluginManifest,
  PluginManifestInput,
  ResourceCandidate,
  ResourceSearchInput,
  ResourceSearchResult,
  StorageActionMap,
  StorageCapability,
  StorageCleanInput,
  StorageCleanOptions,
  StorageContract,
  StorageFileEntry,
  StorageListInput,
  StorageListOptions,
  StorageListSharedFilesInput,
  StorageListing,
  StorageMoveInput,
  StoragePathInput,
  StorageRenameInput,
  StorageRenameItem,
  StorageRenameManyInput,
  StorageRemoveInput,
  StorageRemoveMode,
  StorageRemoveModes,
  StorageSaveInput,
  StorageSaveResult,
  StorageShareFile,
  StorageSharedListing,
  StorageWriteSidecarInput,
  SubtitleCandidate,
  SubtitleDownloadInput,
  SubtitleDownloadResult,
  SubtitleSearchInput,
];

const metadata = defineMetadataPlugin({
  manifest: { id: 'typed-metadata', name: 'Typed metadata', version: '1.0.0' },
  search: async ({ query, mediaType = 'tv' }): Promise<MetadataCandidate[]> => [{
    id: 'sample:' + query,
    externalId: 'sample-1',
    providerId: 'sample',
    mediaType,
    name: query,
    status: 'Running',
    language: 'en',
    genres: ['Drama'],
    posterPath: null,
    backdropPath: null,
    voteAverage: 7.5,
    externalUrl: null,
  }],
  detail: async ({ externalId, mediaType = 'tv' }) => ({
    id: 'sample:' + externalId,
    externalId,
    providerId: 'sample',
    mediaType,
    name: 'Sample series',
    seasons: [{ seasonNumber: 1, episodeCount: 1 }],
  }),
  episodes: async ({ seasonNumber }) => [{ seasonNumber, episodeNumber: 1, name: 'Pilot' }],
});

const resources = defineResourcePlugin({
  manifest: { id: 'typed-resource', name: 'Typed resource', version: '1.0.0' },
  search: async ({ query }, context) => {
    const showId: number | undefined = context.showId;
    const storageId: number | undefined = context.storageId;
    void showId;
    void storageId;
    return [{ shareUrl: 'local-share:/series', title: String(query) }];
  },
});

const subtitles = defineSubtitlePlugin({
  manifest: { id: 'typed-subtitles', name: 'Typed subtitles', version: '1.0.0' },
  search: async () => [{ id: 'sample-subtitle', fileName: 'episode.srt', language: 'en' }],
  download: async () => ({ fileName: 'episode.srt', content: new Uint8Array([1]) }),
});

const storageActions: StorageActionMap<'recycle'> = {
  list: async ({ path, options }) => ({
    path,
    files: [],
    total: 0,
    truncated: false,
    recent: options?.recursive ? [] : undefined,
  }),
  listSharedFiles: async ({ shareUrl }) => {
    void shareUrl;
    return { files: [], total: 0, truncated: false };
  },
  save: async ({ destinationPath, selection }) => ({
    ok: true,
    savedCount: selection.length,
    status: destinationPath,
  }),
  move: async ({ sourcePath, destinationPath }) => ({ ok: true, sourcePath, destinationPath }),
  mkdir: async ({ path }) => ({ ok: true, path }),
  rename: async ({ path, newName }) => ({ ok: true, path, newName }),
  renameMany: async ({ items }) => ({ ok: true, renamedCount: items.length }),
  remove: async ({ path, mode }) => ({ ok: true, path, mode }),
  clean: async ({ path, mode, options }) => ({ ok: true, path, mode, options: options || {} }),
  status: async () => ({ ok: true, configured: true }),
};

const storage = defineStoragePlugin({
  manifest: { id: 'typed-storage', name: 'Typed storage', version: '1.0.0' },
  actions: storageActions,
  removeModes: ['recycle'],
});
const declaredRemoveModes: readonly ['recycle'] = storage.storageContract.removeModes;
const recycleRemoveInput: StorageRemoveInput<'recycle'> = { path: '/old', mode: 'recycle' };

// @ts-expect-error This provider does not declare permanent removal.
const permanentRemoveInput: StorageRemoveInput<'recycle'> = { path: '/old', mode: 'permanent' };

const indexer = definePlugin({
  manifest: {
    id: 'typed-indexer',
    name: 'Typed indexer',
    kind: 'indexer',
    version: '1.0.0',
  },
  actions: { reindex: async ({ path }) => ({ ok: true, path: String(path) }) },
  capabilityDomains: { reindex: ['indexer'] },
  subscriptions: ['asset.created'],
  health: async () => ({ ok: true }),
  monitor: async () => ({ ok: true }),
  reset: async () => {},
  initialize: async (context: PluginContext) => { void context.source; },
  onEvent: async (event, context) => {
    const pluginId: string | undefined = context.pluginId;
    void event.type;
    void context.source;
    void pluginId;
  },
});

const configuredFactory: PluginFactory = {
  manifest: {
    id: 'configured-metadata',
    version: '1.0.0',
    configSchema: {
      version: 1,
      fields: [{ key: 'endpoint', type: 'url', required: true }],
    },
  },
  create: ({ config }) => defineMetadataPlugin({
    manifest: {
      id: 'configured-metadata',
      version: '1.0.0',
      configSchema: {
        version: 1,
        fields: [{ key: 'endpoint', type: 'url', required: true }],
      },
    },
    search: async ({ query }): Promise<MetadataCandidate[]> => [{
      id: 'configured:' + query,
      externalId: config?.endpoint || 'missing-config',
      providerId: 'configured-metadata',
      mediaType: 'tv',
      name: query,
    }],
    detail: async () => null,
    episodes: async () => [],
  }),
};

const plugins: readonly PluginDefinition[] = [metadata, resources, subtitles, storage, indexer];
const sdkRuntimeExports = [
  METADATA_CAPABILITIES,
  PLUGIN_API_VERSION,
  PLUGIN_KINDS,
  RESOURCE_CAPABILITIES,
  STORAGE_CAPABILITIES,
  STORAGE_OPTIONAL_CAPABILITIES,
  STORAGE_REMOVE_MODES,
  SUBTITLE_CAPABILITIES,
  assertPlugin,
  defineMetadataPlugin,
  definePlugin,
  defineResourcePlugin,
  defineStoragePlugin,
  defineSubtitlePlugin,
];
const pluginConfig: PluginConfig = { endpoint: 'https://metadata.example.test' };
const removeMode: StorageRemoveMode = 'permanent';
const apiVersion: 2 = PLUGIN_API_VERSION;

// @ts-expect-error Providers must use one of the declared removal policies.
const invalidRemoveMode: StorageRemoveMode = 'delete';

void plugins;
const publicTypeExports: PublicTypeExports | undefined = undefined;
void publicTypeExports;
void sdkRuntimeExports;
void declaredRemoveModes;
void removeMode;
void apiVersion;
void invalidRemoveMode;
void recycleRemoveInput;
void permanentRemoveInput;
void configuredFactory;
void pluginConfig;

export type PluginKind =
  | 'resource-provider'
  | 'metadata-provider'
  | 'storage-provider'
  | 'indexer'
  | 'notification-provider'
  | 'subtitle-provider'
  | 'workflow-provider';

export type JsonObject = Record<string, unknown>;
export type PluginConfig = Record<string, string>;
export type CapabilityDomains = Record<string, readonly string[]>;
export type PluginAction<Input extends JsonObject = JsonObject, Output = unknown> =
  (input: Input, context: PluginContext) => Output | Promise<Output>;

export interface PluginContext extends JsonObject {
  source?: string;
  correlationId?: string | null;
  pluginId?: string;
  showId?: number;
  storageId?: number;
  config?: PluginConfig;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

export interface ConfigField {
  key: string;
  label?: string;
  type?: 'text' | 'url' | 'password';
  placeholder?: string;
  helpText?: string;
  required?: boolean;
}

export interface ConfigSchema {
  version: 1;
  fields: readonly ConfigField[];
}

export type StorageRemoveMode = 'recycle' | 'permanent';
export type StorageRemoveModes = readonly [StorageRemoveMode, ...StorageRemoveMode[]];
export type StorageCapability = typeof STORAGE_CAPABILITIES[number];

export interface StorageListOptions extends JsonObject {
  recursive?: boolean;
  limit?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface StorageFileEntry extends JsonObject {
  id?: string;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime?: number | null;
}

export interface StorageShareFile extends StorageFileEntry {
  id: string;
}

export interface StorageListing extends JsonObject {
  path: string;
  files: StorageFileEntry[];
  total: number;
  truncated: boolean;
  recent?: boolean | readonly unknown[];
}

export interface StorageSharedListing extends JsonObject {
  files: StorageShareFile[];
  total: number;
  truncated: boolean;
  recent?: boolean | readonly unknown[];
}

export interface StorageListInput extends JsonObject {
  path: string;
  options?: StorageListOptions;
}

export interface StorageListSharedFilesInput extends JsonObject {
  shareUrl: string;
  options?: StorageListOptions;
}

export interface StorageSaveInput extends JsonObject {
  shareUrl: string;
  destinationPath: string;
  selection: StorageShareFile[];
}

export interface StorageSaveResult extends JsonObject {
  ok: boolean;
  savedCount: number;
  completed?: boolean;
  verified?: boolean | null;
  status?: string | null;
}

export interface StorageMoveInput extends JsonObject {
  sourcePath: string;
  destinationPath: string;
}

export interface StoragePathInput extends JsonObject {
  path: string;
}

export interface StorageRenameInput extends StoragePathInput {
  newName: string;
}

export interface StorageRenameItem extends JsonObject {
  path: string;
  newName: string;
}

export interface StorageRenameManyInput extends JsonObject {
  items: readonly [StorageRenameItem, ...StorageRenameItem[]];
}

export interface StorageRemoveInput<Mode extends StorageRemoveMode = StorageRemoveMode>
  extends StoragePathInput {
  mode: Mode;
}

export interface StorageCleanOptions extends JsonObject {
  keepFiles?: string[];
  deleteSubdirs?: boolean;
  deleteDuplicates?: boolean;
}

export interface StorageCleanInput<Mode extends StorageRemoveMode = StorageRemoveMode>
  extends StorageRemoveInput<Mode> {
  options?: StorageCleanOptions;
}

export interface StorageWriteSidecarInput extends JsonObject {
  videoPath: string;
  fileName: string;
  content: Uint8Array;
}

export interface StorageActionMap<Mode extends StorageRemoveMode = StorageRemoveMode> {
  list: PluginAction<StorageListInput, StorageListing>;
  listSharedFiles: PluginAction<StorageListSharedFilesInput, StorageSharedListing>;
  save: PluginAction<StorageSaveInput, StorageSaveResult>;
  move: PluginAction<StorageMoveInput>;
  mkdir: PluginAction<StoragePathInput>;
  rename: PluginAction<StorageRenameInput>;
  renameMany: PluginAction<StorageRenameManyInput>;
  remove: PluginAction<StorageRemoveInput<Mode>>;
  clean: PluginAction<StorageCleanInput<Mode>>;
  status: PluginAction<JsonObject>;
  writeSidecar?: PluginAction<StorageWriteSidecarInput>;
}

export interface StorageContract {
  version: 2;
  coreCapabilities: typeof STORAGE_CAPABILITIES;
  removeModes: StorageRemoveModes;
}

export interface PluginManifest {
  id: string;
  name: string;
  label: string;
  kind: PluginKind;
  version: string;
  apiVersion: 2;
  capabilityDomains: CapabilityDomains;
  configSchema: ConfigSchema;
  storageContract?: StorageContract;
}

export interface PluginDefinition {
  readonly apiVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly kind: PluginKind;
  readonly version: string;
  readonly manifest: PluginManifest;
  readonly capabilities: readonly string[];
  readonly actions: Readonly<Record<string, PluginAction>>;
  readonly configKeys: readonly string[];
  readonly configSchema: ConfigSchema;
  readonly subscriptions: readonly string[];
  readonly storageContract?: StorageContract;
  invoke(request: {
    capability: string;
    input?: JsonObject;
    context?: PluginContext;
  }): Promise<unknown>;
  health(): Promise<JsonObject> | JsonObject;
  monitor(): Promise<JsonObject> | JsonObject;
  reset(): Promise<void> | void;
  onEvent(event: JsonObject, context?: PluginContext): Promise<void> | void;
  initialize?(context?: PluginContext): Promise<void> | void;
}

export interface PluginFactory {
  manifest?: PluginManifestInput;
  create(context: PluginContext): PluginDefinition | Promise<PluginDefinition>;
}

export interface PluginLifecycleOptions {
  configSchema?: ConfigSchema;
  capabilityDomains?: CapabilityDomains;
  subscriptions?: string[];
  onEvent?: (event: JsonObject, context: PluginContext) => Promise<void> | void;
  health?: () => Promise<JsonObject> | JsonObject;
  monitor?: () => Promise<JsonObject> | JsonObject;
  reset?: () => Promise<void> | void;
  initialize?: (context: PluginContext) => Promise<void> | void;
}

export interface MetadataSearchInput extends JsonObject {
  query: string;
  mediaType?: 'tv' | 'movie';
  limit?: number;
}

export interface MetadataDetailInput extends JsonObject {
  externalId: string;
  mediaType?: 'tv' | 'movie';
}

export interface MetadataEpisodesInput extends JsonObject {
  externalId: string;
  seasonNumber: number;
}

export interface ResourceSearchInput extends JsonObject {
  query: string;
  aliases?: string[];
  mediaType?: 'tv' | 'movie';
  storageProvider: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  limit?: number;
}

export type ResourceCandidate = JsonObject & (
  | { shareUrl: string; url?: string }
  | { url: string; shareUrl?: string }
) & {
  title?: string;
  name?: string;
  sourceId?: string | number;
  id?: string | number;
};

export type ResourceSearchResult = ResourceCandidate[] | {
  items: ResourceCandidate[];
  truncated: boolean;
};

export interface SubtitleSearchInput extends JsonObject {
  query: string;
  languages?: string[];
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  limit?: number;
}

export interface SubtitleCandidate extends JsonObject {
  id: string;
  fileName: string;
  language: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  title?: string;
  release?: string;
}

export interface SubtitleDownloadInput extends JsonObject {
  candidateId: string;
}

export interface SubtitleDownloadResult extends JsonObject {
  fileName: string;
  content: Uint8Array;
}

export interface MetadataCandidate extends JsonObject {
  id: string;
  externalId: string;
  providerId: string;
  mediaType: 'tv' | 'movie';
  name: string;
  originalName?: string;
  overview?: string | null;
  firstAirDate?: string | null;
  year?: number | null;
  status?: string | null;
  language?: string | null;
  genres?: string[];
  posterPath?: string | null;
  backdropPath?: string | null;
  voteAverage?: number | null;
  externalUrl?: string | null;
}

export interface MetadataSeason extends JsonObject {
  seasonNumber: number;
  name?: string | null;
  episodeCount?: number | null;
  airDate?: string | null;
  externalId?: string;
}

export interface MetadataEpisode extends JsonObject {
  id?: string;
  externalId?: string;
  seasonNumber: number;
  episodeNumber: number;
  name?: string | null;
  overview?: string | null;
  airDate?: string | null;
  airTime?: string | null;
  runtime?: number | null;
  stillPath?: string | null;
}

export interface MetadataDetail extends MetadataCandidate {
  seasons?: MetadataSeason[];
}

export type PluginManifestInput = Pick<PluginManifest, 'id' | 'version'>
  & Partial<Omit<PluginManifest, 'id' | 'version'>>;

export declare const PLUGIN_API_VERSION: 2;
export declare const PLUGIN_KINDS: readonly PluginKind[];
export declare const METADATA_CAPABILITIES: readonly ['search', 'detail', 'episodes'];
export declare const RESOURCE_CAPABILITIES: readonly ['search'];
export declare const SUBTITLE_CAPABILITIES: readonly ['search', 'download'];
export declare const STORAGE_CAPABILITIES: readonly [
  'list',
  'listSharedFiles',
  'save',
  'move',
  'mkdir',
  'rename',
  'renameMany',
  'remove',
  'clean',
  'status',
];
export declare const STORAGE_OPTIONAL_CAPABILITIES: readonly ['writeSidecar'];
export declare const STORAGE_REMOVE_MODES: readonly StorageRemoveMode[];

export declare function assertPlugin<T extends PluginDefinition>(plugin: T): T;

export declare function definePlugin(options: PluginLifecycleOptions & {
  manifest: PluginManifestInput;
  actions: Record<string, PluginAction>;
  capabilityDomains?: CapabilityDomains;
  storageContract?: StorageContract | null;
}): PluginDefinition;

export declare function defineMetadataPlugin(options: PluginLifecycleOptions & {
  manifest: PluginManifestInput;
  search: PluginAction<MetadataSearchInput, MetadataCandidate[]>;
  detail: PluginAction<MetadataDetailInput, MetadataDetail | null>;
  episodes: PluginAction<MetadataEpisodesInput, MetadataEpisode[]>;
}): PluginDefinition;

export declare function defineResourcePlugin(options: PluginLifecycleOptions & {
  manifest: PluginManifestInput;
  search: PluginAction<ResourceSearchInput, ResourceSearchResult>;
}): PluginDefinition;

export declare function defineSubtitlePlugin(options: PluginLifecycleOptions & {
  manifest: PluginManifestInput;
  search: PluginAction<SubtitleSearchInput, SubtitleCandidate[]>;
  download: PluginAction<SubtitleDownloadInput, SubtitleDownloadResult>;
}): PluginDefinition;

export declare function defineStoragePlugin<const Modes extends StorageRemoveModes>(
  options: PluginLifecycleOptions & {
  manifest: PluginManifestInput;
  actions: StorageActionMap<Modes[number]>;
  removeModes: Modes;
  },
): PluginDefinition & {
  readonly storageContract: StorageContract & { readonly removeModes: Modes };
};

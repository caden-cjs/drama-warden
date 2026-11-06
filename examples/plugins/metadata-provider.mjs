import { defineMetadataPlugin } from '@drama-warden/plugin-sdk';

const EXTERNAL_ID = 'sample-series-001';

const sampleSeries = {
  id: EXTERNAL_ID,
  externalId: EXTERNAL_ID,
  providerId: 'sample-metadata',
  mediaType: 'tv',
  name: 'Sample Series',
  originalName: 'Sample Series',
  overview: 'A deterministic example returned by the provider template.',
  firstAirDate: '2026-01-01',
  year: 2026,
  status: 'Running',
  language: 'en',
  genres: ['Drama'],
  posterPath: null,
  externalUrl: null,
};

export default {
  manifest: { apiVersion: 2 },
  create({ logger } = {}) {
    return defineMetadataPlugin({
      manifest: {
        id: 'sample-metadata',
        name: 'Sample Metadata Provider',
        label: 'Sample Metadata',
        version: '1.0.0',
      },
      search: async ({ query = '', mediaType = 'tv', limit = 10 } = {}) => {
        if (mediaType !== 'tv') return [];
        const normalizedQuery = String(query).trim().toLocaleLowerCase();
        if (!normalizedQuery || !sampleSeries.name.toLocaleLowerCase().includes(normalizedQuery)) {
          return [];
        }
        const resultLimit = Math.max(1, Math.min(25, Number(limit) || 10));
        return [{ ...sampleSeries, score: 1 }].slice(0, resultLimit);
      },
      detail: async ({ externalId, mediaType = 'tv' } = {}) => {
        if (mediaType !== 'tv' || String(externalId) !== EXTERNAL_ID) return null;
        return {
          ...sampleSeries,
          seasons: [{
            seasonNumber: 1,
            name: 'Season 1',
            episodeCount: 2,
            airDate: '2026-01-01',
            externalId: 'sample-season-001',
          }],
        };
      },
      episodes: async ({ externalId, seasonNumber } = {}) => {
        if (String(externalId) !== EXTERNAL_ID || Number(seasonNumber) !== 1) return [];
        return [1, 2].map((episodeNumber) => ({
          id: `sample-episode-${episodeNumber}`,
          externalId: `sample-episode-${episodeNumber}`,
          seasonNumber: 1,
          episodeNumber,
          name: `Example Episode ${episodeNumber}`,
          overview: 'Replace this fixture with the upstream provider response mapping.',
          airDate: `2026-01-0${episodeNumber}`,
          airTime: null,
          runtime: 45,
          stillPath: null,
        }));
      },
      health: async () => ({ ok: true }),
      reset: async () => {
        logger?.debug?.('sample metadata plugin reset');
      },
    });
  },
};

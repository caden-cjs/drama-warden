import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssrtPlugin } from '../plugins/subtitle/assrt.mjs';
import { createOpenSubtitlesPlugin } from '../plugins/subtitle/opensubtitles.mjs';

test('OpenSubtitles plugin normalizes episode candidates and keeps the API key off download links', async () => {
  const calls = [];
  const plugin = createOpenSubtitlesPlugin({
    apiKey: 'test-api-key-value',
    userAgent: 'drama-warden test',
    requestIntervalMs: 0,
    fetchImpl: async (input, options = {}) => {
      const url = new URL(String(input));
      calls.push({ url, options });
      if (url.pathname.endsWith('/subtitles')) {
        return new Response(JSON.stringify({
          data: [{
            attributes: {
              subtitle_id: 'sub-1',
              language: 'zh-CN',
              release: 'Example.Show.S01E02',
              feature_details: { season_number: 1, episode_number: 2 },
              files: [{ file_id: 123, file_name: 'Example.Show.S01E02.srt' }],
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/download')) {
        return new Response(JSON.stringify({
          link: 'https://dl.opensubtitles.com/download/temporary',
          file_name: 'Example.Show.S01E02.srt',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.hostname === 'dl.opensubtitles.com') {
        return new Response(Buffer.from('subtitle-bytes'), { status: 200 });
      }
      return new Response(Buffer.from('subtitle-bytes'), { status: 200 });
    },
  });
  const candidates = await plugin.invoke({
    capability: 'search',
    input: {
      query: 'Example Show S01E02',
      languages: ['zh-CN'],
      seasonNumber: 1,
      episodeNumber: 2,
    },
  });
  assert.deepEqual(candidates, [{
    id: '123',
    fileName: 'Example.Show.S01E02.srt',
    language: 'zh-CN',
    release: 'Example.Show.S01E02',
    seasonNumber: 1,
    episodeNumber: 2,
  }]);
  const result = await plugin.invoke({ capability: 'download', input: { candidateId: '123' } });
  assert.equal(result.fileName, 'Example.Show.S01E02.srt');
  assert.equal(result.content.toString('utf8'), 'subtitle-bytes');
  assert.equal(calls[0].url.searchParams.get('season_number'), '1');
  assert.equal(calls[0].url.searchParams.get('episode_number'), '2');
  assert.equal(calls[0].options.headers['Api-Key'], 'test-api-key-value');
  assert.equal(calls[2].options.headers['Api-Key'], undefined);
  assert.equal(calls[2].url.hostname, 'dl.opensubtitles.com');
});

test('Assrt search carries episode markers from the result row for core matching', async () => {
  const plugin = createAssrtPlugin({
    fetchImpl: async () => new Response(
      '<table><tr><td>Example Show S02E03</td><td><a href="/download/42/example.s02e03.zip">Download</a></td></tr></table>',
      { status: 200 },
    ),
  });
  const results = await plugin.invoke({
    capability: 'search',
    input: { query: 'Example Show S02E03', limit: 5 },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '42/example.s02e03.zip');
  assert.match(results[0].title, /S02E03/);
});

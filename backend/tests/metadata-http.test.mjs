import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMetadataConnection, requestJson } from '../plugins/metadata/http.mjs';

function failedBody(error) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  }));
}

test('metadata requests classify timeouts, body network errors, and invalid JSON separately', async () => {
  const url = new URL('https://metadata.example.test/response');
  const cases = [
    {
      cause: new DOMException('private timeout detail', 'TimeoutError'),
      code: 'METADATA_TIMEOUT',
    },
    {
      cause: new TypeError('private socket detail'),
      code: 'METADATA_NETWORK_ERROR',
    },
  ];

  for (const { cause, code } of cases) {
    await assert.rejects(
      requestJson(url, { fetchImpl: async () => failedBody(cause) }),
      (error) => error.code === code && !error.message.includes('private'),
    );
  }

  await assert.rejects(
    requestJson(url, { fetchImpl: async () => new Response('{invalid json') }),
    (error) => error.code === 'METADATA_INVALID_RESPONSE',
  );
});

test('metadata connection checks return stable body-read timeout codes', async () => {
  const result = await checkMetadataConnection(
    new URL('https://metadata.example.test/health'),
    {
      fetchImpl: async () => failedBody(new DOMException('private timeout detail', 'AbortError')),
    },
  );

  assert.deepEqual(result, {
    ok: false,
    configured: true,
    errorCode: 'METADATA_TIMEOUT',
  });
});

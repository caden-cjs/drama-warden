import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !path.startsWith(sep));
}

export function createStaticHandler({ root } = {}) {
  if (!root) throw new TypeError('frontend static root is required');
  const frontendRoot = resolve(root);
  const indexFile = resolve(frontendRoot, 'index.html');

  return async function handleStatic(request, response, requestUrl) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(response, 405, 'method not allowed');
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname || '/');
    } catch {
      send(response, 400, 'invalid path');
      return;
    }
    if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
      send(response, 400, 'invalid path');
      return;
    }

    const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
    let target = resolve(frontendRoot, '.' + requestedPath);
    if (!isInside(frontendRoot, target)) {
      send(response, 404, 'not found');
      return;
    }

    let content;
    let contentType;
    try {
      content = await readFile(target);
      contentType = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    } catch (error) {
      const acceptsHtml = String(request.headers.accept || '').includes('text/html');
      const spaRoute = acceptsHtml && !extname(decodedPath)
        && !decodedPath.split('/').some((segment) => segment.startsWith('.'));
      if (!spaRoute) {
        send(response, error?.code === 'ENOENT' ? 404 : 500, 'not found');
        return;
      }
      target = indexFile;
      try {
        content = await readFile(target);
        contentType = MIME_TYPES['.html'];
      } catch {
        send(response, 404, 'frontend build is missing; run npm run build');
        return;
      }
    }

    const isHtml = contentType.startsWith('text/html');
    const immutableAsset = decodedPath.startsWith('/assets/');
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': content.byteLength,
      'cache-control': isHtml ? 'no-cache'
        : immutableAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  };
}

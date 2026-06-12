/*
  Service Worker for 日曆記事本
  - Minimal offline is not implemented
  - Implements Web Share Target receiver: POST ./share-target
    Stores payload + files into Cache Storage then redirects to ./?shared=1
*/

const SHARE_CACHE = 'diary-share-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isShareTargetRequest(request) {
  try {
    const url = new URL(request.url);
    // support both /share-target and /share-target.html (GitHub Pages static-friendly)
    return url.pathname.endsWith('/share-target') || url.pathname.endsWith('/share-target.html');
  } catch (_) {
    return false;
  }
}

async function handleShareTarget(request) {
  // Web Share Target requires POST multipart/form-data
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const formData = await request.formData();

  const title = formData.get('title');
  const text = formData.get('text');
  const url = formData.get('url');

  // files field name comes from manifest: "files"
  const files = formData.getAll('files') || [];

  const cache = await caches.open(SHARE_CACHE);

  // Save payload meta
  const payload = {
    title: typeof title === 'string' ? title : '',
    text: typeof text === 'string' ? text : '',
    url: typeof url === 'string' ? url : '',
    filesCount: files.length,
    ts: Date.now(),
  };

  await cache.put('share_payload', new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  }));

  await cache.put('share_files_count', new Response(String(files.length), {
    headers: { 'Content-Type': 'text/plain' },
  }));

  // Save each file as a Response(blob)
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;

    const name = (typeof f.name === 'string' && f.name) ? f.name : `file_${i}`;
    const type = (typeof f.type === 'string' && f.type) ? f.type : 'application/octet-stream';

    // f is a File
    const blob = await f.arrayBuffer().then((buf) => new Blob([buf], { type }));

    await cache.put(`share_file_${i}`, new Response(blob, {
      headers: {
        'Content-Type': type,
        'X-File-Name': encodeURIComponent(name),
      },
    }));
  }

  // Redirect back to app (same scope)
  const redirectUrl = new URL('./?shared=1', request.url).toString();
  return Response.redirect(redirectUrl, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (isShareTargetRequest(req)) {
    event.respondWith(handleShareTarget(req));
  }
});

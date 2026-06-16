/* sw.js - Web Share Target receiver for 日曆記事本 */

const SHARE_CACHE = 'diary-share-cache-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  try {
    if (event && event.data && event.data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
  } catch (_) {}
});

async function storeSharePayload({ title, text, url, files }) {
  const cache = await caches.open(SHARE_CACHE);

  const payload = {
    title: title || '',
    text: text || '',
    url: url || '',
    filesCount: Array.isArray(files) ? files.length : 0
  };

  await cache.put('share_payload', new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }));

  const count = payload.filesCount || 0;
  await cache.put('share_files_count', new Response(String(count), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  }));

  for (let i = 0; i < count; i++) {
    const f = files[i];
    const name = (f && f.name) ? f.name : `file_${i}`;
    const type = (f && f.type) ? f.type : 'application/octet-stream';

    const headers = new Headers({
      'Content-Type': type,
      'X-File-Name': encodeURIComponent(name)
    });

    await cache.put(`share_file_${i}`, new Response(f, { headers }));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Web Share Target POST endpoint
  if (url.pathname.endsWith('/share-target') && req.method === 'POST') {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const title = form.get('title');
        const text = form.get('text');
        const sharedUrl = form.get('url');

        // 'files' may be 0..n File objects
        const files = form.getAll('files').filter(Boolean);

        await storeSharePayload({
          title: title ? String(title) : '',
          text: text ? String(text) : '',
          url: sharedUrl ? String(sharedUrl) : '',
          files
        });

        // Redirect back to app; index.html will consume caches when it sees shared=1
        const redirectTo = new URL('./?shared=1', url);
        return Response.redirect(redirectTo.toString(), 303);
      } catch (e) {
        // fallback: still redirect, but without payload
        const redirectTo = new URL('./?shared=1', url);
        return Response.redirect(redirectTo.toString(), 303);
      }
    })());
    return;
  }

  // Default passthrough
});

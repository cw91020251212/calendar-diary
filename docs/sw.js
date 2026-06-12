/* sw.js - Web Share Target receiver for 日曆記事本 */

const SHARE_CACHE = 'diary-share-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function storeSharePayload(request) {
  const cache = await caches.open(SHARE_CACHE);

  // Parse multipart/form-data
  const formData = await request.formData();

  const title = formData.get('title') || '';
  const text = formData.get('text') || '';
  const url = formData.get('url') || '';
  const files = formData.getAll('files') || [];

  const payload = {
    title: String(title || ''),
    text: String(text || ''),
    url: String(url || ''),
    filesCount: files.length
  };

  await cache.put('share_payload', new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  }));

  await cache.put('share_files_count', new Response(String(files.length), {
    headers: { 'Content-Type': 'text/plain' }
  }));

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!(f instanceof File)) continue;

    // Store blob as Response so the page can read it back
    const headers = new Headers();
    headers.set('Content-Type', f.type || 'application/octet-stream');
    // encodeURIComponent so page can decode safely
    headers.set('X-File-Name', encodeURIComponent(f.name || `file_${i}`));

    await cache.put(`share_file_${i}`, new Response(f, { headers }));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle the share_target action: ./?shared=1 (POST)
  if (req.method === 'POST' && url.searchParams.get('shared') === '1') {
    event.respondWith((async () => {
      try {
        await storeSharePayload(req);
      } catch (e) {
        // If parsing fails, still redirect so app opens; page will just not find payload
        console.error('storeSharePayload failed', e);
      }

      // Redirect to GET so the app JS can consume cache in tryConsumeSharedPayload()
      return Response.redirect(url.pathname + '?shared=1', 303);
    })());
    return;
  }

  // Default passthrough
  event.respondWith(fetch(req));
});

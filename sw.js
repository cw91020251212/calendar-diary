/*
  Service Worker for Web Share Target
  - Receives POST /share-target
  - Stores payload + files into Cache Storage (diary-share-cache-v1)
  - Redirects to ./index.html?shared=1 so the page can consume via tryConsumeSharedPayload()

  Notes:
  - Works only on HTTPS (or http://localhost)
  - Some browsers (especially desktop) may not support share_target
*/

const SHARE_CACHE = 'diary-share-cache-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function putText(cache, key, text) {
  await cache.put(key, new Response(String(text || ''), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
}

async function putJson(cache, key, obj) {
  await cache.put(key, new Response(JSON.stringify(obj || {}), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Share Target endpoint
  if (url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        if (event.request.method !== 'POST') {
          return Response.redirect('./index.html', 303);
        }

        const form = await event.request.formData();
        const title = form.get('title') || '';
        const text = form.get('text') || '';
        const sharedUrl = form.get('url') || '';

        const files = form.getAll('files') || [];

        const cache = await caches.open(SHARE_CACHE);

        await putJson(cache, '/__share_payload__', {
          title: String(title || ''),
          text: String(text || ''),
          url: String(sharedUrl || ''),
          filesCount: files.length
        });

        await putText(cache, '/__share_files_count__', String(files.length));

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          // File object in SW is a Blob; wrap metadata via headers
          const headers = new Headers({
            'Content-Type': f.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(f.name || ('file_' + i))
          });
          await cache.put(`/__share_file___${i}`, new Response(f, { headers }));
        }

        // Redirect to app with shared=1 marker
        return Response.redirect('./index.html?shared=1', 303);
      } catch (e) {
        // On failure, still open app so user can continue
        return Response.redirect('./index.html', 303);
      }
    })());
  }
});

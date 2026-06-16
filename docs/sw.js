/* sw.js - Web Share Target receiver for 日曆記事本
 *
 * Purpose:
 * - Receive Android share-sheet POST to ./?shared=1 (Web Share Target)
 * - Store payload into Cache Storage so index.html can consume it
 * - Redirect user to GET ./?shared=1 so the app can read cached payload
 */

const CACHE_NAME = 'diary-share-cache-v3';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

// ✅ v4：支持頁面要求立即啟用新 SW
self.addEventListener('message', (event) => {
  try {
    if (event && event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  } catch (_) {}
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function writeText(cache, key, text) {
  const resp = new Response(String(text ?? ''), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
  await cache.put(key, resp);
}

async function writeJson(cache, key, obj) {
  const resp = new Response(JSON.stringify(obj ?? {}), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  await cache.put(key, resp);
}

function isShareTargetRequest(requestUrl, requestMethod) {
  try {
    const u = new URL(requestUrl);
    return requestMethod === 'POST' && u.searchParams.get('shared') === '1';
  } catch (_) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!isShareTargetRequest(req.url, req.method)) return;

  event.respondWith((async () => {
    try {
      const formData = await req.formData();
      const title = formData.get('title');
      const text = formData.get('text');
      const url = formData.get('url');

      const files = formData.getAll('files') || [];

      const cache = await caches.open(CACHE_NAME);

      // Main payload
      await writeJson(cache, 'share_payload', {
        title: title ? String(title) : '',
        text: text ? String(text) : '',
        url: url ? String(url) : '',
        filesCount: Array.isArray(files) ? files.length : 0,
      });

      // Files (if any)
      const n = Array.isArray(files) ? files.length : 0;
      await writeText(cache, 'share_files_count', String(n));

      for (let i = 0; i < n; i++) {
        const f = files[i];
        if (!(f instanceof File)) continue;

        // Store raw blob; attach filename via header so page can retrieve
        const headers = new Headers();
        headers.set('Content-Type', f.type || 'application/octet-stream');
        try { headers.set('X-File-Name', encodeURIComponent(f.name || `file_${i}`)); } catch (_) {}

        await cache.put(`share_file_${i}`, new Response(f, { headers }));
      }

      // Redirect to GET so app can load and consume from cache
      // ✅ 同時把 title/text/url 放入 query 做後備（某些機種 Cache API/控制時序會不穩）
      const u = new URL(req.url);
      u.searchParams.set('shared', '1');
      try {
        if (title) u.searchParams.set('title', String(title));
        if (text) u.searchParams.set('text', String(text));
        if (url) u.searchParams.set('url', String(url));
      } catch (_) {}
      return Response.redirect(u.toString(), 303);
    } catch (e) {
      // On failure, still redirect to app without payload
      try {
        const u = new URL(req.url);
        u.searchParams.set('shared', '1');
        return Response.redirect(u.toString(), 303);
      } catch (_) {
        return new Response('share target error', { status: 500 });
      }
    }
  })());
});

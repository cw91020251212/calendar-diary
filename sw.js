/* Service Worker for Web Share Target */

const SHARE_CACHE = 'diary-share-cache-v1';
const PAYLOAD_KEY = '/__share_payload__';
const FILE_KEY_PREFIX = '/__share_file__';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function storeSharePayload(payload, files) {
  const cache = await caches.open(SHARE_CACHE);

  // 清理舊檔（最多清 10 個）
  const keys = await cache.keys();
  await Promise.all(keys
    .filter(req => req.url.includes(FILE_KEY_PREFIX) || req.url.endsWith(PAYLOAD_KEY))
    .map(req => cache.delete(req))
  );

  await cache.put(PAYLOAD_KEY, new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  }));

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const blob = await f.arrayBuffer();
    await cache.put(`${FILE_KEY_PREFIX}_${i}`, new Response(blob, {
      headers: {
        'Content-Type': f.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(f.name || `image_${i}`)
      }
    }));
  }

  await cache.put('/__share_files_count__', new Response(String(files.length), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  }));
}

async function handleShareTargetPost(request) {
  const formData = await request.formData();

  const title = formData.get('title') || '';
  const text = formData.get('text') || '';
  const url = formData.get('url') || '';

  const files = formData.getAll('files').filter(v => v && typeof v === 'object' && 'arrayBuffer' in v);

  const payload = {
    title: String(title),
    text: String(text),
    url: String(url),
    receivedAt: Date.now(),
    filesCount: files.length
  };

  await storeSharePayload(payload, files);

  // 303 轉去主頁，讓 index.html 去讀 cache 入面嘅分享內容
  return Response.redirect('index.html?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Web Share Target action
  if (url.pathname.endsWith('/share-target') && event.request.method === 'POST') {
    event.respondWith(handleShareTargetPost(event.request));
    return;
  }
});

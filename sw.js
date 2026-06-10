/* Service Worker for Web Share Target */

const SHARE_CACHE = 'diary-share-cache-v1';
// 使用相對路徑作為 Cache Key，避免 GitHub Pages 子目錄路徑問題
const PAYLOAD_KEY = 'share_payload';
const FILE_KEY_PREFIX = 'share_file';
const COUNT_KEY = 'share_files_count';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function storeSharePayload(payload, files) {
  const cache = await caches.open(SHARE_CACHE);

  // 清理舊檔
  const keys = await cache.keys();
  await Promise.all(keys.map(req => cache.delete(req)));

  // 儲存文字內容
  await cache.put(PAYLOAD_KEY, new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  }));

  // 儲存檔案
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

  // 儲存檔案總數
  await cache.put(COUNT_KEY, new Response(String(files.length), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  }));
}

async function handleShareTargetPost(request) {
  try {
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

    // 重新導向回主頁並帶上 shared=1 參數
    // 使用相對路徑確保在子目錄下也能正確導向
    return Response.redirect('index.html?shared=1', 303);
  } catch (err) {
    console.error('Share Target Error:', err);
    return Response.redirect('index.html?share_error=1', 303);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 攔截分享動作：匹配路徑結尾為 /share-target 且為 POST 請求
  // 使用 .includes 或正則表達式以增加相容性
  if (url.pathname.includes('share-target') && event.request.method === 'POST') {
    event.respondWith(handleShareTargetPost(event.request));
  }
});

const CACHE_NAME = 'diary-app-v20260724v7';
const SHARE_CACHE_NAME = 'diary-share-cache-v4';

// 需要快取的靜態資源
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-v2-192.png',
  './icon-v2-512.png',
  './icon-v2-1024.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME && key !== SHARE_CACHE_NAME)
            .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// 處理分享接收 (Web Share Target)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 攔截 manifest.json 中定義的 action URL
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const title = formData.get('title') || '';
        const text = formData.get('text') || '';
        const urlParam = formData.get('url') || '';
        const files = formData.getAll('files'); // 對應 manifest 中的 params.files.name

        const cache = await caches.open(SHARE_CACHE_NAME);

        // 1. 儲存文字內容
        const payload = {
          title,
          text,
          url: urlParam,
          filesCount: files.length,
          timestamp: Date.now()
        };
        await cache.put('share_payload', new Response(JSON.stringify(payload)));

        // 2. 儲存檔案數量
        await cache.put('share_files_count', new Response(files.length.toString()));

        // 3. 逐個儲存檔案
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          // 建立 Response 並把檔名塞入 Header，方便 index.html 讀取
          const response = new Response(file, {
            headers: {
              'Content-Type': file.type,
              'X-File-Name': encodeURIComponent(file.name)
            }
          });
          await cache.put(`share_file_${i}`, response);
        }

        // 重定向到主頁面並帶上 shared=1 參數
        return Response.redirect('./index.html?shared=1', 303);
      })()
    );
    return;
  }

  // 標準快取策略：網絡優先，失敗則使用快取
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

// 監聽來自頁面的跳過等待指令
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

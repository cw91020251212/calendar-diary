const CACHE_NAME = 'diary-app-v20261119v1';
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

// === 背景推播接收與通知點擊處理 ===
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: '日記提醒', body: '有一個記事提醒到時間了。按一下開啟日記。' };
  }

  // 忽略過期通知，避免手機離線太久後收到已不合時的提醒。
  if (data.expiresAt && Date.now() > Number(data.expiresAt)) return;

  event.waitUntil(self.registration.showNotification(data.title || '日記提醒', {
    body: data.body || '有一個記事提醒到時間了。按一下開啟日記。',
    icon: './icon-v2-192.png',
    badge: './icon-v2-192.png',
    tag: data.tag || `diary-reminder-${data.reminderId || 'generic'}`,
    data: { url: data.url || './', reminderId: data.reminderId || null },
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const fallback = new URL('./', self.registration.scope).href;
  let target = fallback;
  try {
    const candidate = new URL(event.notification.data?.url || fallback, self.location.origin);
    const scope = new URL(self.registration.scope);
    if (candidate.origin === scope.origin && candidate.pathname.startsWith(scope.pathname)) target = candidate.href;
  } catch {
    // Keep the same-origin app URL fallback.
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin
      && new URL(client.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (existing) {
      if ('navigate' in existing) await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});

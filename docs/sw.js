const CACHE_NAME = 'diary-app-v20261119v2';
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
        keys.filter((key) => key.startsWith('diary-app-') && key !== CACHE_NAME && key !== SHARE_CACHE_NAME)
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
      const scope = new URL(self.registration.scope);
      if (event.request.mode === 'navigate' && url.origin === scope.origin
          && url.pathname.startsWith(scope.pathname)) {
        return caches.open(CACHE_NAME).then(async (cache) => {
          return await cache.match(new URL('index.html', scope).href)
            || await cache.match(scope.href)
            || caches.match(event.request);
        });
      }
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
  let data = {};
  try {
    const payload = event.data && event.data.json();
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) data = payload;
  } catch {
    // Show the generic notification even if the payload is missing or invalid.
  }

  // Expired pushes must still produce a visible notification, without opening the stale reminder.
  const expiresAt = Number(data.expiresAt);
  if (data.expiresAt != null && Number.isFinite(expiresAt) && Date.now() >= expiresAt) data = {};
  const reminderId = typeof data.reminderId === 'string' ? data.reminderId : null;

  event.waitUntil(self.registration.showNotification('日記提醒', {
    body: '請開啟日記查看。',
    icon: './icon-v2-192.png',
    badge: './icon-v2-192.png',
    tag: `diary-reminder-${reminderId || 'generic'}`,
    data: { url: typeof data.url === 'string' ? data.url : './', reminderId },
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = new URL(self.registration.scope);
  let target = new URL(scope.href);
  const reminderId = typeof event.notification.data?.reminderId === 'string'
    ? event.notification.data.reminderId : null;
  try {
    const candidate = new URL(event.notification.data?.url || scope.href, scope);
    if (candidate.origin === scope.origin && candidate.pathname.startsWith(scope.pathname)
        && !candidate.username && !candidate.password) target = candidate;
  } catch {
    // Keep the same-origin app URL fallback.
  }
  if (reminderId) target.searchParams.set('reminder', reminderId);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === scope.origin
      && new URL(client.url).pathname.startsWith(scope.pathname));
    if (existing) {
      existing.postMessage({ type: 'DIARY_REMINDER_CLICK', reminderId });
      return existing.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});

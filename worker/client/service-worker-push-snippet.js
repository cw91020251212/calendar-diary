// Draft snippet to append to docs/sw.js; preserve its existing cache and share-target handlers.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "日記提醒", body: "有一個記事提醒到時間了。按一下開啟日記。" };
  }

  // 忽略過期通知，避免手機離線太久後收到已不合時的提醒。
  if (data.expiresAt && Date.now() > Number(data.expiresAt)) return;

  event.waitUntil(self.registration.showNotification(data.title || "日記提醒", {
    body: data.body || "有一個記事提醒到時間了。按一下開啟日記。",
    icon: "./icon-v2-192.png",
    badge: "./icon-v2-192.png",
    tag: data.tag || `diary-reminder-${data.reminderId || "generic"}`,
    data: { url: data.url || "./", reminderId: data.reminderId || null },
    renotify: true,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const fallback = new URL("./", self.registration.scope).href;
  let target = fallback;
  try {
    const candidate = new URL(event.notification.data?.url || fallback, self.location.origin);
    const scope = new URL(self.registration.scope);
    if (candidate.origin === scope.origin && candidate.pathname.startsWith(scope.pathname)) target = candidate.href;
  } catch {
    // Keep the same-origin app URL fallback.
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin
      && new URL(client.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (existing) {
      if ("navigate" in existing) await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});

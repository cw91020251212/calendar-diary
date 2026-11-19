// Draft integration only. Replace API_BASE_URL after a later, separately approved deployment.
const API_BASE_URL = "https://calendar-diary-reminders-draft.<account>.workers.dev";
const DEVICE_TOKEN_KEY = "diary_push_device_token_v1";

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function getDeviceToken() {
  let token = localStorage.getItem(DEVICE_TOKEN_KEY);
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = bytesToBase64Url(bytes);
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  }
  return token;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = new Headers({ "Accept": "application/json" });
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${getDeviceToken()}`);
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `提醒服務錯誤（${response.status}）`);
  return result;
}

async function ensurePermission() {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("這個瀏覽器不支援背景推播；請用支援通知的 Android 瀏覽器並以 HTTPS 開啟。");
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("尚未允許日記網站顯示通知。");
  return navigator.serviceWorker.ready;
}

export async function enableReminderPush() {
  const registration = await ensurePermission();
  const { vapidPublicKey } = await api("/v1/config");
  if (!vapidPublicKey || vapidPublicKey.startsWith("REPLACE_")) {
    throw new Error("背景提醒服務尚未完成設定。");
  }

  const applicationServerKey = base64UrlToBytes(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  // 每次進入設定都 upsert，避免第一次上傳失敗後留下本機孤兒訂閱。
  await api("/v1/subscribe", {
    method: "POST",
    body: { subscription: subscription.toJSON() },
  });
  return { enabled: true };
}

export async function scheduleReminderPush(id, dueAt) {
  await enableReminderPush();
  return api("/v1/reminders", {
    method: "POST",
    body: { id, dueAt: Number(dueAt) },
  });
}

export async function cancelReminderPush(id) {
  return api("/v1/reminders/cancel", {
    method: "POST",
    body: { id },
  });
}

export async function disableReminderPush() {
  const result = await api("/v1/unsubscribe", { method: "POST", body: {} });
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  localStorage.removeItem(DEVICE_TOKEN_KEY);
  return result;
}

export function localReminderDateTime(dateStr, timeStr) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeStr || ""));
  if (!dateMatch || !timeMatch) throw new Error("請選擇有效日期和時間。");
  const [, year, month, day] = dateMatch.map(Number);
  const [, hour, minute] = timeMatch.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (hour > 23 || minute > 59 || date.getFullYear() !== year || date.getMonth() !== month - 1
      || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute
      || date.getTime() <= Date.now()) {
    throw new Error("提醒時間必須是有效的未來時間。");
  }
  return date.getTime();
}

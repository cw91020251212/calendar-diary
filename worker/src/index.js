import { sendPushNotification, WebPushError } from "@mmmike/web-push/send";

const ALLOWED_ORIGIN = "https://cw91020251212.github.io";
const APP_URL = `${ALLOWED_ORIGIN}/calendar-diary/`;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_DEVICE = 100;
const MAX_ATTEMPTS = 5;
const PUSH_TTL_SECONDS = 60 * 60;
const MAX_LATE_DISPLAY_MS = 2 * 60 * 60 * 1000;

const POST_PATHS = new Set([
  "/v1/subscribe",
  "/v1/reminders",
  "/v1/reminders/cancel",
  "/v1/unsubscribe",
]);

function corsHeaders(origin) {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  if (origin === ALLOWED_ORIGIN) headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  return headers;
}

function json(request, data, status = 200) {
  const headers = corsHeaders(request.headers.get("Origin"));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function bearerToken(request) {
  const value = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(value);
  return match ? match[1] : null;
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkRateLimit(binding, key) {
  if (!binding || typeof binding.limit !== "function") return "unavailable";
  try {
    const result = await binding.limit({ key });
    return result?.success === true ? "allowed" : "blocked";
  } catch {
    return "unavailable";
  }
}

function validPushEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com"
      || host === "web.push.apple.com"
      || host === "notify.windows.com"
      || host.endsWith(".notify.windows.com")
      || host.endsWith(".push.services.mozilla.com");
  } catch {
    return false;
  }
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 12_000) return null;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 12_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function subscriptionFromRow(row) {
  return {
    endpoint: row.endpoint,
    expirationTime: null,
    keys: { p256dh: row.p256dh, auth: row.auth_key },
  };
}

async function processDueReminders(env, now) {
  const selected = await env.DB.prepare(
    `SELECT id, device_hash, due_at, expires_at, attempts
       FROM reminders
      WHERE due_at <= ?
        AND ((status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'sending' AND lease_until <= ?))
      ORDER BY due_at ASC
      LIMIT 50`,
  ).bind(now, now, now).all();

  let deliveredOrExpired = 0;
  for (const reminder of selected.results || []) {
    const claim = await env.DB.prepare(
      `UPDATE reminders
          SET status = 'sending', lease_until = ?, attempts = attempts + 1
        WHERE id = ?
          AND ((status = 'pending' AND next_attempt_at <= ?)
            OR (status = 'sending' AND lease_until <= ?))`,
    ).bind(now + 120_000, reminder.id, now, now).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;

    const subscriptionRow = await env.DB.prepare(
      `SELECT endpoint, p256dh, auth_key FROM subscriptions WHERE device_hash = ?`,
    ).bind(reminder.device_hash).first();

    if (!subscriptionRow || reminder.expires_at <= now) {
      await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(reminder.id).run();
      deliveredOrExpired++;
      continue;
    }

    const payload = {
      title: "日記提醒",
      body: "有一個記事提醒到時間了。按一下開啟日記。",
      tag: `diary-reminder-${reminder.id}`,
      url: `${APP_URL}?reminder=${encodeURIComponent(reminder.id)}`,
      reminderId: reminder.id,
      expiresAt: reminder.expires_at,
    };
    const vapid = {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT || APP_URL,
    };

    try {
      const accepted = await sendPushNotification(
        subscriptionFromRow(subscriptionRow),
        payload,
        vapid,
        { ttl: PUSH_TTL_SECONDS, urgency: "high" },
      );
      if (accepted) {
        // Push service 接受不等同手機已顯示；網路／OS 通知設定仍會影響實際到達。
        await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(reminder.id).run();
      } else {
        // 404/410：推播訂閱已失效，停止重試並清掉失效 endpoint。
        await env.DB.prepare("DELETE FROM subscriptions WHERE device_hash = ?").bind(reminder.device_hash).run();
        await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(reminder.id).run();
      }
      deliveredOrExpired++;
    } catch (error) {
      const attempt = Number(reminder.attempts || 0) + 1;
      const statusCode = error instanceof WebPushError ? error.statusCode : 0;
      if (statusCode === 404 || statusCode === 410) {
        await env.DB.prepare("DELETE FROM subscriptions WHERE device_hash = ?").bind(reminder.device_hash).run();
        await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(reminder.id).run();
        deliveredOrExpired++;
      } else if (attempt >= MAX_ATTEMPTS) {
        await env.DB.prepare(
          `UPDATE reminders SET status = 'failed', attempts = ?, lease_until = NULL
            WHERE id = ?`,
        ).bind(attempt, reminder.id).run();
      } else {
        const retryDelay = error instanceof WebPushError && Number(error.retryAfterMs) > 0
          ? Math.min(Number(error.retryAfterMs), 15 * 60 * 1000)
          : 60_000;
        await env.DB.prepare(
          `UPDATE reminders
              SET status = 'pending', attempts = ?, next_attempt_at = ?, lease_until = NULL
            WHERE id = ?`,
        ).bind(attempt, now + retryDelay, reminder.id).run();
      }
    }
  }

  // 失敗紀錄只保留 30 日，避免資料無限累積。
  await env.DB.prepare(
    "DELETE FROM reminders WHERE status = 'failed' AND created_at < ?",
  ).bind(now - 30 * 24 * 60 * 60 * 1000).run();

  return { checked: selected.results?.length || 0, handled: deliveredOrExpired };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    if (origin !== ALLOWED_ORIGIN) return json(request, { error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (request.method === "GET" && url.pathname === "/v1/config") {
      if (!env.VAPID_PUBLIC_KEY) return json(request, { error: "push_not_configured" }, 503);
      return json(request, { vapidPublicKey: env.VAPID_PUBLIC_KEY });
    }

    if (request.method !== "POST") return json(request, { error: "method_not_allowed" }, 405);
    if (!POST_PATHS.has(url.pathname)) return json(request, { error: "not_found" }, 404);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipLimit = await checkRateLimit(env.IP_RATE_LIMITER, `${ip}:${url.pathname}`);
    if (ipLimit === "blocked") return json(request, { error: "rate_limited" }, 429);

    const token = bearerToken(request);
    if (!token) return json(request, { error: "device_token_required" }, 401);
    const deviceHash = await hashToken(token);
    const deviceLimit = await checkRateLimit(env.DEVICE_RATE_LIMITER, `${deviceHash}:${url.pathname}`);
    if (deviceLimit === "blocked") return json(request, { error: "rate_limited" }, 429);

    if (url.pathname === "/v1/subscribe") {
      const body = await readJson(request);
      const sub = body?.subscription;
      if (!sub || !validPushEndpoint(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
        return json(request, { error: "invalid_subscription" }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO subscriptions (device_hash, endpoint, p256dh, auth_key, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_hash) DO UPDATE SET
           endpoint = excluded.endpoint,
           p256dh = excluded.p256dh,
           auth_key = excluded.auth_key,
           updated_at = excluded.updated_at`,
      ).bind(deviceHash, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
      return json(request, { ok: true });
    }

    if (url.pathname === "/v1/reminders") {
      const body = await readJson(request);
      const id = String(body?.id || "");
      const dueAt = Number(body?.dueAt);
      const now = Date.now();
      if (!/^[a-f0-9-]{36}$/i.test(id) || !Number.isSafeInteger(dueAt)
          || dueAt <= now || dueAt > now + MAX_FUTURE_MS) {
        return json(request, { error: "invalid_reminder" }, 400);
      }
      const subscription = await env.DB.prepare(
        "SELECT device_hash FROM subscriptions WHERE device_hash = ?",
      ).bind(deviceHash).first();
      if (!subscription) return json(request, { error: "push_not_enabled" }, 409);

      const existing = await env.DB.prepare("SELECT device_hash FROM reminders WHERE id = ?").bind(id).first();
      if (existing && existing.device_hash !== deviceHash) return json(request, { error: "not_found" }, 404);
      if (!existing) {
        const pending = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM reminders WHERE device_hash = ? AND status IN ('pending', 'sending')",
        ).bind(deviceHash).first();
        if (Number(pending?.count || 0) >= MAX_PENDING_PER_DEVICE) {
          return json(request, { error: "too_many_pending_reminders" }, 429);
        }
      }

      const expiresAt = dueAt + MAX_LATE_DISPLAY_MS;
      await env.DB.prepare(
        `INSERT INTO reminders
           (id, device_hash, due_at, next_attempt_at, expires_at, attempts, status, created_at, lease_until)
         VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           due_at = excluded.due_at,
           next_attempt_at = excluded.next_attempt_at,
           expires_at = excluded.expires_at,
           attempts = 0,
           status = 'pending',
           created_at = excluded.created_at,
           lease_until = NULL
         WHERE reminders.device_hash = excluded.device_hash`,
      ).bind(id, deviceHash, dueAt, dueAt, expiresAt, now).run();
      return json(request, { ok: true, id, dueAt });
    }

    if (url.pathname === "/v1/reminders/cancel") {
      const body = await readJson(request);
      const id = String(body?.id || "");
      if (!/^[a-f0-9-]{36}$/i.test(id)) return json(request, { error: "invalid_reminder_id" }, 400);
      await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND device_hash = ?")
        .bind(id, deviceHash).run();
      return json(request, { ok: true });
    }

    if (url.pathname === "/v1/unsubscribe") {
      await env.DB.prepare("DELETE FROM subscriptions WHERE device_hash = ?").bind(deviceHash).run();
      await env.DB.prepare("DELETE FROM reminders WHERE device_hash = ?").bind(deviceHash).run();
      return json(request, { ok: true });
    }

    return json(request, { error: "not_found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueReminders(env, controller.scheduledTime || Date.now()));
  },
};

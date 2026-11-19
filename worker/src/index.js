import { sendPushNotification, WebPushError } from "@mmmike/web-push/send";

const ALLOWED_ORIGIN = "https://cw91020251212.github.io";
const APP_URL = `${ALLOWED_ORIGIN}/calendar-diary/`;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_DEVICE = 100;
const MAX_SUBSCRIPTIONS = 200;
const MAX_STORED_REMINDERS = 1000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 5;
const LEASE_MS = 120_000;
const SEND_TIMEOUT_MS = 10_000;
const FRESH_SUBSCRIPTION_MS = 60_000;
const PUSH_TTL_SECONDS = 60 * 60;
const MAX_LATE_DISPLAY_MS = 2 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 12_000;

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

function decodeKey(value, size) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, "");
  const padding = (4 - unpadded.length % 4) % 4;
  if (value.length !== unpadded.length && value.length - unpadded.length !== padding) return null;
  try {
    const binary = atob(unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding));
    const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (binary.length !== size || canonical !== unpadded) return null;
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeKey(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function validVapidConfig(env) {
  try {
    const publicKey = decodeKey(env.VAPID_PUBLIC_KEY, 65);
    const privateKey = decodeKey(env.VAPID_PRIVATE_KEY, 32);
    if (!publicKey || publicKey[0] !== 4 || !privateKey
        || !/^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT || APP_URL)) return false;
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };
    const verifier = await crypto.subtle.importKey("raw", publicKey, algorithm, false, ["verify"]);
    const signer = await crypto.subtle.importKey("jwk", {
      kty: "EC", crv: "P-256", x: encodeKey(publicKey.slice(1, 33)),
      y: encodeKey(publicKey.slice(33)), d: encodeKey(privateKey),
    }, algorithm, false, ["sign"]);
    const message = new TextEncoder().encode("calendar-diary-vapid-check");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, message);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, message);
  } catch {
    return false;
  }
}

function validPushEndpoint(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f#\\]/.test(value)) return false;
  const authority = /^https:\/\/([^/?]+)/i.exec(value)?.[1];
  if (!authority || authority.includes("@")) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com"
      || host.endsWith(".push.apple.com")
      || host === "notify.windows.com"
      || host.endsWith(".notify.windows.com")
      || host.endsWith(".push.services.mozilla.com");
  } catch {
    return false;
  }
}

async function validSubscription(sub) {
  if (!sub || !validPushEndpoint(sub.endpoint)) return false;
  const publicKey = decodeKey(sub.keys?.p256dh, 65);
  if (!publicKey || publicKey[0] !== 4 || !decodeKey(sub.keys?.auth, 16)) return false;
  try {
    await crypto.subtle.importKey("raw", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    reader.cancel().catch(() => {});
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

// next_attempt_at holds a random generation token only while sending; SQLite's
// non-STRICT INTEGER affinity permits this without a schema change. updated_at
// likewise holds time:UUID for new subscriptions; legacy integer times work too.
// The numeric lease_until still governs recovery of abandoned claims.
const CLAIM_WHERE = "id = ? AND device_hash = ? AND status = 'sending' AND lease_until = ? AND next_attempt_at = ? AND attempts = ? AND due_at = ? AND expires_at = ? AND created_at = ? AND stage = ?";

function claimArgs(reminder) {
  return [reminder.id, reminder.device_hash, reminder.lease_until, reminder.next_attempt_at,
    reminder.attempts, reminder.due_at, reminder.expires_at, reminder.created_at, reminder.stage];
}

async function retryClaim(env, reminder, delayMs) {
  const now = Date.now();
  if (reminder.attempts >= MAX_ATTEMPTS || !Number.isFinite(delayMs) || now + delayMs >= reminder.expires_at) {
    await env.DB.prepare(`UPDATE reminders SET status = 'failed', lease_until = NULL WHERE ${CLAIM_WHERE}`)
      .bind(...claimArgs(reminder)).run();
  } else {
    await env.DB.prepare(`UPDATE reminders SET status = 'pending', next_attempt_at = ?, lease_until = NULL WHERE ${CLAIM_WHERE}`)
      .bind(now + delayMs, ...claimArgs(reminder)).run();
  }
}

export async function processDueReminders(env, sendPush = sendPushNotification) {
  const now = Date.now();
  const selected = await env.DB.prepare(
    `SELECT id FROM reminders
      WHERE due_at <= ?
        AND ((status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'sending' AND lease_until <= ?))
      ORDER BY due_at ASC
      LIMIT ?`,
  ).bind(now, now, now, BATCH_SIZE).all();

  let deliveredOrExpired = 0;
  for (const selectedRow of selected.results || []) {
    const claimNow = Date.now();
    const generation = crypto.randomUUID();
    const reminder = await env.DB.prepare(
      `UPDATE reminders
          SET status = 'sending', lease_until = ?, next_attempt_at = ?, attempts = attempts + 1
        WHERE id = ? AND due_at <= ? AND attempts < ?
          AND ((status = 'pending' AND next_attempt_at <= ?)
            OR (status = 'sending' AND lease_until <= ?))
        RETURNING id, device_hash, due_at, expires_at, attempts, lease_until, next_attempt_at, created_at,
          title, body, clear_at, stage`,
    ).bind(claimNow + LEASE_MS, generation, selectedRow.id, claimNow, MAX_ATTEMPTS, claimNow, claimNow).first();
    if (!reminder) {
      // A crashed final attempt must not leave a permanently claimable row.
      await env.DB.prepare(
        `UPDATE reminders SET status = 'failed', lease_until = NULL
          WHERE id = ? AND due_at <= ? AND attempts >= ?
            AND ((status = 'pending' AND next_attempt_at <= ?)
              OR (status = 'sending' AND lease_until <= ?))`,
      ).bind(selectedRow.id, claimNow, MAX_ATTEMPTS, claimNow, claimNow).run();
      continue;
    }

    if (reminder.expires_at <= Date.now()) {
      const deleted = await env.DB.prepare(`DELETE FROM reminders WHERE ${CLAIM_WHERE}`)
        .bind(...claimArgs(reminder)).run();
      deliveredOrExpired += deleted.meta?.changes || 0;
      continue;
    }

    // Do not show a delayed all-day notification after its local-day window.
    // A close-stage row is already handled by the normal due-time path below.
    if (reminder.stage === "show" && Number(reminder.clear_at) > 0
        && Number(reminder.clear_at) <= Date.now()) {
      const deleted = await env.DB.prepare(`DELETE FROM reminders WHERE ${CLAIM_WHERE}`)
        .bind(...claimArgs(reminder)).run();
      deliveredOrExpired += deleted.meta?.changes || 0;
      continue;
    }

    const subscriptionRow = await env.DB.prepare(
      `SELECT endpoint, p256dh, auth_key, updated_at FROM subscriptions WHERE device_hash = ?`,
    ).bind(reminder.device_hash).first();

    if (!subscriptionRow) {
      const deleted = await env.DB.prepare(
        `DELETE FROM reminders WHERE ${CLAIM_WHERE}
          AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE device_hash = ?)`,
      ).bind(...claimArgs(reminder), reminder.device_hash).run();
      if (deleted.meta?.changes) deliveredOrExpired++;
      else await retryClaim(env, reminder, 60_000);
      continue;
    }

    const remainingMs = reminder.expires_at - Date.now();
    if (remainingMs <= 0) {
      const deleted = await env.DB.prepare(`DELETE FROM reminders WHERE ${CLAIM_WHERE}`)
        .bind(...claimArgs(reminder)).run();
      deliveredOrExpired += deleted.meta?.changes || 0;
      continue;
    }
    const payload = {
      action: reminder.stage === "close" ? "close" : "show",
      title: reminder.title || "日記提醒",
      body: reminder.body || "有一個記事提醒到時間了。按一下開啟日記。",
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

    let accepted;
    try {
      const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
      const timeout = new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      accepted = await Promise.race([
        sendPush(subscriptionFromRow(subscriptionRow), payload, vapid, {
          ttl: Math.min(PUSH_TTL_SECONDS, Math.floor(remainingMs / 1000)),
          urgency: "high",
          timeoutMs: SEND_TIMEOUT_MS,
          signal,
        }),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        accepted = false;
      } else {
        const retryAfter = error instanceof WebPushError ? error.retryAfterMs : null;
        const retryDelay = retryAfter == null ? 60_000 : Math.max(60_000, Number(retryAfter));
        await retryClaim(env, reminder, retryDelay);
        continue;
      }
    }
    if (accepted) {
      // Push service 接受不等同手機已顯示；網絡／OS 通知設定仍會影響實際到達。
      if (reminder.stage === "show" && Number(reminder.clear_at) > 0) {
        const clearAt = Number(reminder.clear_at);
        const advanced = await env.DB.prepare(
          `UPDATE reminders SET stage = 'close', due_at = ?, next_attempt_at = ?,
             expires_at = ?, attempts = 0, status = 'pending', lease_until = NULL
           WHERE ${CLAIM_WHERE}`,
        ).bind(clearAt, clearAt, clearAt + MAX_LATE_DISPLAY_MS, ...claimArgs(reminder)).run();
        deliveredOrExpired += advanced.meta?.changes || 0;
      } else {
        const deleted = await env.DB.prepare(`DELETE FROM reminders WHERE ${CLAIM_WHERE}`)
          .bind(...claimArgs(reminder)).run();
        deliveredOrExpired += deleted.meta?.changes || 0;
      }
    } else if (Date.now() - Number.parseInt(subscriptionRow.updated_at, 10) < FRESH_SUBSCRIPTION_MS) {
      // A newly uploaded subscription can briefly return 404/410 while registering.
      await retryClaim(env, reminder, 15_000);
    } else {
      const deletedSub = await env.DB.prepare(
        `DELETE FROM subscriptions WHERE device_hash = ? AND endpoint = ? AND p256dh = ? AND auth_key = ? AND updated_at = ?
          AND EXISTS (SELECT 1 FROM reminders WHERE ${CLAIM_WHERE})`,
      ).bind(reminder.device_hash, subscriptionRow.endpoint, subscriptionRow.p256dh,
        subscriptionRow.auth_key, subscriptionRow.updated_at, ...claimArgs(reminder)).run();
      if (deletedSub.meta?.changes) {
        const deleted = await env.DB.prepare(
          `DELETE FROM reminders WHERE ${CLAIM_WHERE}
            AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE device_hash = ?)`,
        ).bind(...claimArgs(reminder), reminder.device_hash).run();
        if (deleted.meta?.changes) deliveredOrExpired++;
        else await retryClaim(env, reminder, 15_000);
      } else {
        // The subscription or reminder changed while this send was in flight.
        await retryClaim(env, reminder, 15_000);
      }
    }
  }

  // 失敗紀錄只保留 30 日，避免資料無限累積。
  await env.DB.prepare(
    "DELETE FROM reminders WHERE id IN (SELECT id FROM reminders WHERE status = 'failed' AND created_at < ? LIMIT 50)",
  ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000).run();

  return { checked: selected.results?.length || 0, handled: deliveredOrExpired };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    if (origin !== ALLOWED_ORIGIN) return json(request, { error: "origin_not_allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const isConfig = request.method === "GET" && url.pathname === "/v1/config";
    if (!isConfig && request.method !== "POST") return json(request, { error: "method_not_allowed" }, 405);
    if (!isConfig && !POST_PATHS.has(url.pathname)) return json(request, { error: "not_found" }, 404);

    // These limits are approximate per Cloudflare location, not authentication.
    // Origin can be forged; account-wide caps below limit storage, not all abuse.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipLimit = await checkRateLimit(env.IP_RATE_LIMITER, ip);
    if (ipLimit !== "allowed") return json(request, { error: ipLimit === "blocked" ? "rate_limited" : "rate_limit_unavailable" }, ipLimit === "blocked" ? 429 : 503);

    if (isConfig) {
      if (!await validVapidConfig(env)) return json(request, { error: "push_not_configured" }, 503);
      return json(request, { vapidPublicKey: env.VAPID_PUBLIC_KEY });
    }

    const token = bearerToken(request);
    if (!token) return json(request, { error: "device_token_required" }, 401);
    const deviceHash = await hashToken(token);
    const deviceLimit = await checkRateLimit(env.DEVICE_RATE_LIMITER, deviceHash);
    if (deviceLimit !== "allowed") return json(request, { error: deviceLimit === "blocked" ? "rate_limited" : "rate_limit_unavailable" }, deviceLimit === "blocked" ? 429 : 503);

    if (url.pathname === "/v1/subscribe") {
      const body = await readJson(request);
      const sub = body?.subscription;
      if (!await validSubscription(sub)) return json(request, { error: "invalid_subscription" }, 400);
      const result = await env.DB.prepare(
        `INSERT INTO subscriptions (device_hash, endpoint, p256dh, auth_key, updated_at)
         SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM subscriptions WHERE device_hash = ?)
             OR (SELECT COUNT(*) FROM subscriptions) < ?
         ON CONFLICT(device_hash) DO UPDATE SET
           endpoint = excluded.endpoint,
           p256dh = excluded.p256dh,
           auth_key = excluded.auth_key,
           updated_at = excluded.updated_at`,
      ).bind(deviceHash, sub.endpoint, sub.keys.p256dh, sub.keys.auth, `${Date.now()}:${crypto.randomUUID()}`, deviceHash, MAX_SUBSCRIPTIONS).run();
      if (!result.meta?.changes) return json(request, { error: "too_many_subscriptions" }, 429);
      return json(request, { ok: true });
    }

    if (url.pathname === "/v1/reminders") {
      const body = await readJson(request);
      const id = String(body?.id || "");
      const dueAt = Number(body?.dueAt);
      const mode = body?.mode === "all_day" ? "all_day" : "timed";
      const rawTitle = typeof body?.title === "string" ? body.title : "日記提醒";
      const rawBody = typeof body?.body === "string" ? body.body : "有一個記事提醒到時間了。按一下開啟日記。";
      const title = rawTitle.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "日記提醒";
      const notificationBody = rawBody.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180) || "請開啟日記查看。";
      const clearAt = mode === "all_day" ? Number(body?.clearAt) : null;
      const now = Date.now();
      if (!/^[a-f0-9-]{36}$/i.test(id) || !Number.isSafeInteger(dueAt)
          || dueAt <= now || dueAt > now + MAX_FUTURE_MS
          || (mode === "all_day" && (!Number.isSafeInteger(clearAt) || clearAt <= dueAt || clearAt > dueAt + 48 * 60 * 60 * 1000))) {
        return json(request, { error: "invalid_reminder" }, 400);
      }
      const expiresAt = (clearAt || dueAt) + MAX_LATE_DISPLAY_MS;
      // Each check and the write are one SQLite statement, including updates
      // from failed to pending and the global cap on all stored statuses.
      const result = await env.DB.prepare(
        `INSERT INTO reminders
           (id, device_hash, due_at, next_attempt_at, expires_at, attempts, status, created_at, lease_until,
            title, body, clear_at, stage)
         SELECT ?, ?, ?, ?, ?, 0, 'pending', ?, NULL, ?, ?, ?, 'show'
          WHERE EXISTS (SELECT 1 FROM subscriptions WHERE device_hash = ?)
            AND (EXISTS (SELECT 1 FROM reminders WHERE id = ? AND device_hash = ? AND status IN ('pending', 'sending'))
              OR (SELECT COUNT(*) FROM reminders WHERE device_hash = ? AND status IN ('pending', 'sending')) < ?)
            AND (EXISTS (SELECT 1 FROM reminders WHERE id = ? AND device_hash = ?)
              OR (SELECT COUNT(*) FROM reminders) < ?)
         ON CONFLICT(id) DO UPDATE SET
           due_at = excluded.due_at,
           next_attempt_at = excluded.next_attempt_at,
           expires_at = excluded.expires_at,
           attempts = 0,
           status = 'pending',
           created_at = excluded.created_at,
           lease_until = NULL,
           title = excluded.title,
           body = excluded.body,
           clear_at = excluded.clear_at,
           stage = 'show'
         WHERE reminders.device_hash = excluded.device_hash`,
      ).bind(id, deviceHash, dueAt, dueAt, expiresAt, now, title, notificationBody, clearAt, deviceHash,
        id, deviceHash, deviceHash, MAX_PENDING_PER_DEVICE, id, deviceHash, MAX_STORED_REMINDERS).run();
      if (!result.meta?.changes) {
        const existing = await env.DB.prepare("SELECT device_hash FROM reminders WHERE id = ?").bind(id).first();
        if (existing && existing.device_hash !== deviceHash) return json(request, { error: "not_found" }, 404);
        const subscription = await env.DB.prepare("SELECT device_hash FROM subscriptions WHERE device_hash = ?").bind(deviceHash).first();
        if (!subscription) return json(request, { error: "push_not_enabled" }, 409);
        return json(request, { error: "too_many_reminders" }, 429);
      }
      return json(request, { ok: true, id, dueAt, mode, clearAt });
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
      await env.DB.batch([
        env.DB.prepare("DELETE FROM subscriptions WHERE device_hash = ?").bind(deviceHash),
        env.DB.prepare("DELETE FROM reminders WHERE device_hash = ?").bind(deviceHash),
      ]);
      return json(request, { ok: true });
    }

    return json(request, { error: "not_found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueReminders(env));
  },
};

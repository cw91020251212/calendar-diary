import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { WebPushError } from "@mmmike/web-push/send";
import worker, { processDueReminders } from "../src/index.js";

const ORIGIN = "https://cw91020251212.github.io";
const token = "a".repeat(43);
const otherToken = "b".repeat(43);
const allow = { async limit() { return { success: true }; } };
const encoded = (bytes) => Buffer.from(bytes).toString("base64url");
const deviceHash = async (value) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");

async function keyPair() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = encoded(await crypto.subtle.exportKey("raw", keys.publicKey));
  const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d;
  return { publicKey, privateKey };
}
const vapid = await keyPair();
const otherVapid = await keyPair();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/example",
  keys: { p256dh: vapid.publicKey, auth: encoded(crypto.getRandomValues(new Uint8Array(16))) },
};

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const DB = {
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
    },
  };
  return { sqlite, DB };
}

function makeEnv(DB) {
  return { DB, IP_RATE_LIMITER: allow, DEVICE_RATE_LIMITER: allow,
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
}

function request(path, body, bearer = token, extraHeaders = {}) {
  const headers = { Origin: ORIGIN, "CF-Connecting-IP": "192.0.2.1", ...extraHeaders };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request(`https://worker.invalid${path}`, {
    method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function post(env, path, body, bearer = token) {
  return worker.fetch(request(path, body, bearer), env);
}

function addSubscription(sqlite, hash, updatedAt = Date.now() - 120_000, sub = subscription) {
  sqlite.prepare("INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?)")
    .run(hash, sub.endpoint, sub.keys.p256dh, sub.keys.auth, updatedAt);
}

function addReminder(sqlite, hash, options = {}) {
  const now = Date.now();
  const { id = crypto.randomUUID(), due = now - 1000, expires = now + 3_600_000,
    attempts = 0, status = "pending", next = due, lease = null, created = now } = options;
  sqlite.prepare("INSERT INTO reminders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, hash, due, next, expires, attempts, status, created, lease);
  return id;
}

function row(sqlite, id) { return sqlite.prepare("SELECT * FROM reminders WHERE id = ?").get(id); }

test("configuration has separate positive rate-limit namespaces and fail-closed limits", async () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.ratelimits.map((limit) => limit.name), ["IP_RATE_LIMITER", "DEVICE_RATE_LIMITER"]);
  assert.equal(new Set(config.ratelimits.map((limit) => limit.namespace_id)).size, 2);
  assert.ok(config.ratelimits.every((limit) => /^[1-9]\d*$/.test(limit.namespace_id) && limit.simple.period === 60));
  const env = makeEnv(makeDb().DB);
  assert.equal((await worker.fetch(request("/v1/config"), { ...env, IP_RATE_LIMITER: undefined })).status, 503);
  assert.equal((await post({ ...env, DEVICE_RATE_LIMITER: undefined }, "/v1/subscribe", { subscription })).status, 503);
  assert.equal((await post({ ...env, IP_RATE_LIMITER: { async limit() { throw new Error(); } } }, "/v1/subscribe", {})).status, 503);
  assert.equal((await post({ ...env, DEVICE_RATE_LIMITER: { async limit() { return { success: false }; } } }, "/v1/subscribe", {})).status, 429);
  const seen = [];
  const capture = { async limit({ key }) { seen.push(key); return { success: true }; } };
  await post({ ...env, IP_RATE_LIMITER: capture }, "/v1/subscribe", {});
  await post({ ...env, IP_RATE_LIMITER: capture }, "/v1/reminders", {});
  assert.deepEqual(seen, ["192.0.2.1", "192.0.2.1"]);
});

test("public config validates matching private and public VAPID keys without exposing the secret", async () => {
  const env = makeEnv(makeDb().DB);
  let response = await worker.fetch(request("/v1/config"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { vapidPublicKey: vapid.publicKey });
  for (const broken of [undefined, "bad", otherVapid.privateKey, "A".repeat(43)]) {
    response = await worker.fetch(request("/v1/config"), { ...env, VAPID_PRIVATE_KEY: broken });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text, '{"error":"push_not_configured"}');
    assert.ok(!text.includes(vapid.privateKey));
  }
  assert.equal((await worker.fetch(request("/v1/config"), { ...env, VAPID_SUBJECT: "http://invalid" })).status, 503);
});

test("enrollment accepts real provider URL shapes and validates URL and key formats", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  for (const endpoint of [subscription.endpoint, "https://web.push.apple.com/path", "https://a.web.push.apple.com/path", "https://wns2.notify.windows.com/path", "https://updates.push.services.mozilla.com/path"]) {
    assert.equal((await post(env, "/v1/subscribe", { subscription: { ...subscription, endpoint } })).status, 200, endpoint);
  }
  const previous = sqlite.prepare("SELECT updated_at FROM subscriptions").get().updated_at;
  await post(env, "/v1/subscribe", { subscription });
  assert.notEqual(sqlite.prepare("SELECT updated_at FROM subscriptions").get().updated_at, previous);
  for (const endpoint of ["http://fcm.googleapis.com/path", "https://fcm.googleapis.com:444/path", "https://user:pass@fcm.googleapis.com/path", "https://@fcm.googleapis.com/path", "https://fcm.googleapis.com/path#fragment", "https://fcm.googleapis.com/path#", "https://fcm.googleapis.com.evil.test/path", "https://push.apple.com/path", "https://fcm.googleapis.com/pa th", "https:\\\\fcm.googleapis.com/path"]) {
    assert.equal((await post(env, "/v1/subscribe", { subscription: { ...subscription, endpoint } })).status, 400, endpoint);
  }
  for (const keys of [
    { ...subscription.keys, p256dh: "bad" },
    { ...subscription.keys, p256dh: encoded(new Uint8Array([4, ...new Uint8Array(64)])) },
    { ...subscription.keys, auth: "a" },
    { ...subscription.keys, auth: `${subscription.keys.auth}="` },
  ]) assert.equal((await post(env, "/v1/subscribe", { subscription: { ...subscription, keys } })).status, 400);
  const padded = { p256dh: `${subscription.keys.p256dh}=`, auth: `${subscription.keys.auth}==` };
  assert.equal((await post(env, "/v1/subscribe", { subscription: { ...subscription, keys: padded } })).status, 200);
});

test("request body reading stops at the byte limit without relying on Content-Length", async () => {
  const env = makeEnv(makeDb().DB);
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(6001).fill(120)); },
    cancel() { cancelled = true; },
  });
  const req = new Request("https://worker.invalid/v1/subscribe", {
    method: "POST", headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` }, body: stream, duplex: "half",
  });
  assert.equal((await worker.fetch(req, env)).status, 400);
  assert.ok(pulls <= 3);
  assert.equal(cancelled, true);
  assert.equal((await worker.fetch(request("/v1/subscribe", {}, token, { "Content-Length": "12001" }), env)).status, 400);
});

test("subscription cap allows existing device refresh but not new enrollments", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  const hash = await deviceHash(token);
  addSubscription(sqlite, hash);
  for (let i = 0; i < 199; i++) addSubscription(sqlite, `device-${i}`);
  assert.equal((await post(env, "/v1/subscribe", { subscription })).status, 200);
  assert.equal((await post(env, "/v1/subscribe", { subscription }, otherToken)).status, 429);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM subscriptions").get().n, 200);
});

test("atomic reminder caps include failed rows and permit existing active updates", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  const hash = await deviceHash(token);
  addSubscription(sqlite, hash);
  const active = addReminder(sqlite, hash);
  for (let i = 0; i < 99; i++) addReminder(sqlite, hash);
  const failed = addReminder(sqlite, hash, { status: "failed" });
  const dueAt = Date.now() + 120_000;
  assert.equal((await post(env, "/v1/reminders", { id: active, dueAt })).status, 200);
  assert.equal((await post(env, "/v1/reminders", { id: failed, dueAt })).status, 429);
  assert.equal((await post(env, "/v1/reminders", { id: crypto.randomUUID(), dueAt })).status, 429);
  sqlite.prepare("DELETE FROM reminders WHERE id != ?").run(active);
  for (let i = 0; i < 998; i++) addReminder(sqlite, `other-${i}`, { status: "failed" });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const responses = await Promise.all(ids.map((id) => post(env, "/v1/reminders", { id, dueAt })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM reminders").get().n, 1000);
  assert.equal((await post(env, "/v1/reminders", { id: active, dueAt })).status, 200);
  assert.equal((await post(env, "/v1/reminders", { id: active, dueAt }, otherToken)).status, 404);
});

test("unsubscribe deletes both tables atomically", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  const hash = await deviceHash(token);
  addSubscription(sqlite, hash);
  const id = addReminder(sqlite, hash);
  sqlite.exec("CREATE TRIGGER deny_delete BEFORE DELETE ON reminders BEGIN SELECT RAISE(ABORT, 'test'); END");
  await assert.rejects(post(env, "/v1/unsubscribe", {}));
  assert.ok(sqlite.prepare("SELECT * FROM subscriptions WHERE device_hash = ?").get(hash));
  assert.ok(row(sqlite, id));
  sqlite.exec("DROP TRIGGER deny_delete");
  assert.equal((await post(env, "/v1/unsubscribe", {})).status, 200);
  assert.equal(sqlite.prepare("SELECT * FROM subscriptions WHERE device_hash = ?").get(hash), undefined);
  assert.equal(row(sqlite, id), undefined);
});

test("batch size, per-claim real time, send timeout and expiration TTL are bounded", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  const hash = await deviceHash(token);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    addSubscription(sqlite, hash);
    for (let i = 0; i < 6; i++) addReminder(sqlite, hash, { expires: now + 90_000 });
    const leases = [];
    const ttls = [];
    const result = await processDueReminders(env, async (_sub, payload, _vapid, options) => {
      leases.push(row(sqlite, payload.reminderId).lease_until);
      ttls.push(options.ttl);
      assert.equal(options.timeoutMs, 10_000);
      now += 11_000;
      return true;
    });
    assert.equal(result.checked, 5);
    assert.equal(result.handled, 5);
    assert.equal(leases[1] - leases[0], 11_000);
    assert.equal(ttls[0], 90);
    assert.equal(ttls[1], 79);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM reminders").get().n, 1);
  } finally { Date.now = realNow; }
});

test("a stalled send is aborted and scheduled for retry", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  const hash = await deviceHash(token);
  addSubscription(sqlite, hash);
  const id = addReminder(sqlite, hash);
  const originalTimeout = AbortSignal.timeout;
  let signal;
  AbortSignal.timeout = (ms) => {
    assert.equal(ms, 10_000);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
    return controller.signal;
  };
  try {
    await processDueReminders(env, async (_sub, _payload, _vapid, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    assert.equal(signal.aborted, true);
    assert.equal(row(sqlite, id).status, "pending");
    assert.equal(row(sqlite, id).attempts, 1);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test("an old send cannot delete or retry a changed reminder generation", async () => {
  for (const result of ["success", "error", "gone", "recreated"]) {
    const { sqlite, DB } = makeDb();
    const env = makeEnv(DB);
    const hash = await deviceHash(token);
    addSubscription(sqlite, hash);
    const id = addReminder(sqlite, hash);
    const dueAt = Date.now() + 300_000;
    await processDueReminders(env, async () => {
      if (result === "recreated") sqlite.prepare("DELETE FROM reminders WHERE id = ?").run(id);
      assert.equal((await post(env, "/v1/reminders", { id, dueAt })).status, 200);
      if (result === "error") throw new Error("mock failure");
      return result !== "gone";
    });
    const reminder = row(sqlite, id);
    assert.equal(reminder.status, "pending", result);
    assert.equal(reminder.due_at, dueAt, result);
    assert.equal(reminder.attempts, 0, result);
    assert.ok(sqlite.prepare("SELECT * FROM subscriptions WHERE device_hash = ?").get(hash), result);
  }
});

test("an old send cannot modify a reclaimed lease even if its deadline is unchanged", async () => {
  for (const result of ["success", "error", "gone"]) {
    const { sqlite, DB } = makeDb();
    const env = makeEnv(DB);
    const hash = await deviceHash(token);
    addSubscription(sqlite, hash);
    const id = addReminder(sqlite, hash);
    await processDueReminders(env, async () => {
      sqlite.prepare("UPDATE reminders SET next_attempt_at = ?, attempts = attempts + 1 WHERE id = ?")
        .run("a-different-claim", id);
      if (result === "error") throw new Error("mock failure");
      return result !== "gone";
    });
    assert.equal(row(sqlite, id).next_attempt_at, "a-different-claim", result);
    assert.equal(row(sqlite, id).status, "sending", result);
    assert.ok(sqlite.prepare("SELECT * FROM subscriptions WHERE device_hash = ?").get(hash));
  }
});

test("gone endpoints retain fresh or concurrently refreshed subscriptions, but remove unchanged old ones", async () => {
  for (const mode of ["fresh", "fresh410", "refresh", "replacement", "old"]) {
    const { sqlite, DB } = makeDb();
    const env = makeEnv(DB);
    const hash = await deviceHash(token);
    addSubscription(sqlite, hash, Date.now() - (mode.startsWith("fresh") ? 1000 : 120_000));
    const id = addReminder(sqlite, hash);
    await processDueReminders(env, async () => {
      if (mode === "refresh") assert.equal((await post(env, "/v1/subscribe", { subscription })).status, 200);
      if (mode === "replacement") {
        const replacement = { ...subscription, endpoint: "https://web.push.apple.com/new", keys: { ...subscription.keys, auth: encoded(new Uint8Array(16).fill(9)) } };
        assert.equal((await post(env, "/v1/subscribe", { subscription: replacement })).status, 200);
      }
      if (mode === "fresh410") throw new WebPushError("gone", 410, "", "https://example.invalid");
      return false;
    });
    const sub = sqlite.prepare("SELECT * FROM subscriptions WHERE device_hash = ?").get(hash);
    if (mode === "old") {
      assert.equal(sub, undefined);
      assert.equal(row(sqlite, id), undefined);
    } else {
      assert.ok(sub);
      assert.equal(row(sqlite, id).status, "pending");
    }
  }
});

test("Retry-After is not truncated and retries stop at the attempt and expiry limits", async () => {
  const { sqlite, DB } = makeDb();
  const env = makeEnv(DB);
  const hash = await deviceHash(token);
  addSubscription(sqlite, hash);
  const id = addReminder(sqlite, hash, { expires: Date.now() + 3_600_000 });
  const before = Date.now();
  await processDueReminders(env, async () => { throw new WebPushError("rate limit", 429, "", "https://example.invalid", "1200"); });
  assert.equal(row(sqlite, id).status, "pending");
  assert.ok(row(sqlite, id).next_attempt_at >= before + 1_200_000);
  sqlite.prepare("UPDATE reminders SET next_attempt_at = ?, expires_at = ? WHERE id = ?").run(Date.now() - 1, Date.now() + 600_000, id);
  await processDueReminders(env, async () => { throw new WebPushError("rate limit", 429, "", "https://example.invalid", "1200"); });
  assert.equal(row(sqlite, id).status, "failed");
  const last = addReminder(sqlite, hash, { attempts: 4 });
  await processDueReminders(env, async () => { throw new Error("mock failure"); });
  assert.equal(row(sqlite, last).status, "failed");
  const crashed = addReminder(sqlite, hash, { attempts: 5, status: "sending", next: "old-generation", lease: Date.now() - 1 });
  await processDueReminders(env, async () => { throw new Error("must not send"); });
  assert.equal(row(sqlite, crashed).status, "failed");
});

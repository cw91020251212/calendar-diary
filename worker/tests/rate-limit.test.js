import test from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit } from "../src/index.js";

test("allows requests accepted by the rate-limit binding", async () => {
  const binding = { async limit({ key }) { assert.equal(key, "device:/v1/reminders"); return { success: true }; } };
  assert.equal(await checkRateLimit(binding, "device:/v1/reminders"), "allowed");
});

test("blocks requests rejected by the rate-limit binding", async () => {
  const binding = { async limit() { return { success: false }; } };
  assert.equal(await checkRateLimit(binding, "ip:/v1/subscribe"), "blocked");
});

test("fails closed if the binding is missing or throws", async () => {
  assert.equal(await checkRateLimit(undefined, "ip:/v1/subscribe"), "unavailable");
  const binding = { async limit() { throw new Error("unavailable"); } };
  assert.equal(await checkRateLimit(binding, "ip:/v1/subscribe"), "unavailable");
});

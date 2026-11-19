import test from "node:test";
import assert from "node:assert/strict";
import { localReminderDateTime } from "../client/reminder-push-client.js";

test("parses a future phone-local date/time into milliseconds", () => {
  const result = localReminderDateTime("2099-12-31", "23:59");
  assert.ok(Number.isSafeInteger(result));
  const date = new Date(result);
  assert.equal(date.getFullYear(), 2099);
  assert.equal(date.getMonth(), 11);
  assert.equal(date.getDate(), 31);
  assert.equal(date.getHours(), 23);
  assert.equal(date.getMinutes(), 59);
});

test("rejects malformed or impossible date/time values", () => {
  assert.throws(() => localReminderDateTime("2099-02-30", "09:00"));
  assert.throws(() => localReminderDateTime("2099-12-31", "25:00"));
  assert.throws(() => localReminderDateTime("2099/12/31", "09:00"));
});

test("rejects a reminder time in the past", () => {
  const past = new Date(Date.now() - 60_000);
  const dateStr = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
  assert.throws(() => localReminderDateTime(dateStr, timeStr));
});

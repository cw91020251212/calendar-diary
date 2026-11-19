CREATE TABLE IF NOT EXISTS subscriptions (
  device_hash TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed')),
  created_at INTEGER NOT NULL,
  lease_until INTEGER
);

CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders(status, next_attempt_at, due_at);

CREATE INDEX IF NOT EXISTS reminders_device_status_idx
  ON reminders(device_hash, status);

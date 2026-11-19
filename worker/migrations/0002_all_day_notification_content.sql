ALTER TABLE reminders ADD COLUMN title TEXT NOT NULL DEFAULT '日記提醒';
ALTER TABLE reminders ADD COLUMN body TEXT NOT NULL DEFAULT '有一個記事提醒到時間了。按一下開啟日記。';
ALTER TABLE reminders ADD COLUMN clear_at INTEGER;
ALTER TABLE reminders ADD COLUMN stage TEXT NOT NULL DEFAULT 'show' CHECK (stage IN ('show', 'close'));

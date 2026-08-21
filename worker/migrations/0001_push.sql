CREATE TABLE IF NOT EXISTS push_subscriptions (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, device_id)
);

CREATE TABLE IF NOT EXISTS push_reminders (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reminder_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  target_url TEXT NOT NULL,
  PRIMARY KEY (uid, device_id, reminder_id)
);

CREATE INDEX IF NOT EXISTS push_reminders_due ON push_reminders (fire_at);

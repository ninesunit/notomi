import { DurableObject } from 'cloudflare:workers';
import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from '@block65/webcrypto-web-push';

export type ScheduledReminderInput = {
  id: string;
  title: string;
  body: string;
  at: number;
  url?: string;
};

type StoredVapid = {
  public_key: string;
  private_key: string;
};

type DueReminder = {
  reminder_id: string;
  title: string;
  body: string;
  fire_at: number;
  first_fire_at: number;
  target_url: string;
  attempts: number;
};

const VAPID_SUBJECT = 'https://notomii.web.app';

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function generateVapidKeys(): Promise<StoredVapid> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  if (!publicJwk.x || !publicJwk.y || !privateJwk.d) {
    throw new Error('Could not create the notification signing key.');
  }

  const x = decodeBase64Url(publicJwk.x);
  const y = decodeBase64Url(publicJwk.y);
  const rawPublicKey = new Uint8Array(1 + x.length + y.length);
  rawPublicKey[0] = 0x04;
  rawPublicKey.set(x, 1);
  rawPublicKey.set(y, 1 + x.length);

  return {
    public_key: encodeBase64Url(rawPublicKey),
    private_key: privateJwk.d,
  };
}

/**
 * One isolated reminder queue per signed-in device.
 *
 * The queue owns its Web Push key and one alarm. That removes the global
 * minute-by-minute scan and shared D1 database while keeping reminders durable
 * after the browser closes. Each device can wake independently, so one busy
 * student's queue cannot serialize every other student's notifications.
 */
export class ReminderDevice extends DurableObject<Env> {
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS vapid (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          public_key TEXT NOT NULL,
          private_key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscription (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reminders (
          reminder_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          fire_at INTEGER NOT NULL,
          first_fire_at INTEGER NOT NULL,
          target_url TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS reminders_due ON reminders (fire_at);
      `);

      if (sql.exec<StoredVapid>('SELECT public_key, private_key FROM vapid WHERE id = 1').toArray().length === 0) {
        const keys = await generateVapidKeys();
        sql.exec(
          'INSERT OR IGNORE INTO vapid (id, public_key, private_key) VALUES (1, ?, ?)',
          keys.public_key,
          keys.private_key
        );
      }
    });
  }

  private keys(): StoredVapid {
    return this.ctx.storage.sql
      .exec<StoredVapid>('SELECT public_key, private_key FROM vapid WHERE id = 1')
      .one();
  }

  private async scheduleNext(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ fire_at: number | null }>('SELECT MIN(fire_at) AS fire_at FROM reminders')
      .one();
    if (typeof row.fire_at === 'number') {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, row.fire_at));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async publicKey(): Promise<string> {
    await this.ready;
    return this.keys().public_key;
  }

  async syncReminders(
    subscription: PushSubscription,
    reminders: ScheduledReminderInput[]
  ): Promise<number> {
    await this.ready;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        `INSERT INTO subscription (id, payload) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
        JSON.stringify(subscription)
      );
      sql.exec('DELETE FROM reminders');
      for (const reminder of reminders) {
        sql.exec(
          `INSERT INTO reminders
             (reminder_id, title, body, fire_at, first_fire_at, target_url, attempts)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          reminder.id,
          reminder.title,
          reminder.body,
          Math.round(reminder.at),
          Math.round(reminder.at),
          reminder.url ?? '/dashboard'
        );
      }
    });
    await this.scheduleNext();
    return reminders.length;
  }

  async clear(): Promise<void> {
    await this.ready;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM reminders');
      this.ctx.storage.sql.exec('DELETE FROM subscription');
    });
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.ready;
    const subscriptionRow = this.ctx.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM subscription WHERE id = 1')
      .toArray()[0];
    if (!subscriptionRow) {
      this.ctx.storage.sql.exec('DELETE FROM reminders');
      await this.scheduleNext();
      return;
    }

    let subscription: PushSubscription;
    try {
      subscription = JSON.parse(subscriptionRow.payload) as PushSubscription;
    } catch {
      await this.clear();
      return;
    }

    const due = this.ctx.storage.sql
      .exec<DueReminder>(
        `SELECT reminder_id, title, body, fire_at, first_fire_at, target_url, attempts
         FROM reminders WHERE fire_at <= ? ORDER BY fire_at ASC LIMIT 10`,
        Date.now()
      )
      .toArray();
    const keys = this.keys();
    const vapid: VapidKeys = {
      subject: VAPID_SUBJECT,
      publicKey: keys.public_key,
      privateKey: keys.private_key,
    };

    const outcomes = await Promise.all(due.map(async (reminder) => {
      try {
        const payload = await buildPushPayload(
          {
            data: JSON.stringify({
              title: reminder.title,
              body: reminder.body,
              url: reminder.target_url,
              tag: reminder.reminder_id,
            }),
            options: { ttl: 60 * 60 },
          },
          subscription,
          vapid
        );
        const response = await fetch(subscription.endpoint, payload);
        if (response.ok) return { reminder, result: 'delivered' as const };
        if (response.status === 404 || response.status === 410) {
          return { reminder, result: 'expired' as const };
        }
        return { reminder, result: 'retry' as const };
      } catch {
        return { reminder, result: 'retry' as const };
      }
    }));

    const now = Date.now();
    let subscriptionExpired = false;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      for (const { reminder, result } of outcomes) {
        if (result === 'expired') {
          subscriptionExpired = true;
          break;
        }
        if (result === 'delivered') {
          sql.exec('DELETE FROM reminders WHERE reminder_id = ?', reminder.reminder_id);
          continue;
        }

        const nextAttempt = reminder.attempts + 1;
        if (nextAttempt > 6 || now - reminder.first_fire_at > 60 * 60_000) {
          sql.exec('DELETE FROM reminders WHERE reminder_id = ?', reminder.reminder_id);
        } else {
          const backoff = Math.min(5 * 60_000, 60_000 * (2 ** reminder.attempts));
          sql.exec(
            'UPDATE reminders SET attempts = ?, fire_at = ? WHERE reminder_id = ?',
            nextAttempt,
            now + backoff,
            reminder.reminder_id
          );
        }
      }

      if (subscriptionExpired) {
        sql.exec('DELETE FROM reminders');
        sql.exec('DELETE FROM subscription');
      }
    });
    await this.scheduleNext();
  }
}

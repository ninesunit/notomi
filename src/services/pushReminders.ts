import { Platform } from 'react-native';
import { getFirebaseAuth } from '@/services/firebase';
import { R2_WORKER_URL } from '@/services/r2Storage';
import type { Reminder } from '@/services/reminders';

export type BackgroundReminderState =
  | 'checking'
  | 'ready'
  | 'local-only'
  | 'install-required'
  | 'unconfigured'
  | 'error';

const DEVICE_KEY = 'notomi:push-device';

function isIOS(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function browserSupportsPush(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' &&
    'serviceWorker' in navigator && 'PushManager' in window;
}

function applicationServerKey(value: string): ArrayBuffer {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const bytes = atob(padded);
  const buffer = new ArrayBuffer(bytes.length);
  const output = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    output[index] = bytes.charCodeAt(index);
  }
  return buffer;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function authenticatedFetch(path: string, init: RequestInit): Promise<Response> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('No signed-in user for reminder sync.');
  const token = await user.getIdToken();
  return fetch(`${R2_WORKER_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Store one compact four-week reminder queue in a per-device Durable Object.
 *
 * This deliberately reuses the already-authenticated R2 Worker and never
 * creates Firebase reminder documents/listeners. A schedule change replaces
 * the queue in one request; opening the app every 30 seconds does not.
 */
export async function syncBackgroundReminders(
  reminders: Reminder[]
): Promise<BackgroundReminderState> {
  if (!browserSupportsPush()) return 'local-only';
  if (isIOS() && !isStandalone()) return 'install-required';
  if (!R2_WORKER_URL) return 'unconfigured';

  const user = getFirebaseAuth().currentUser;
  // Guest workspaces are wiped on sign-out. Keeping a durable server queue for
  // them would be surprising and waste free-tier storage.
  if (!user || user.isAnonymous) return 'local-only';

  try {
    const registration = await navigator.serviceWorker.ready;
    const currentDeviceId = deviceId();
    const keyResponse = await authenticatedFetch(
      `/push/key?deviceId=${encodeURIComponent(currentDeviceId)}`,
      { method: 'GET' }
    );
    if (!keyResponse.ok) throw new Error(`Reminder key returned ${keyResponse.status}.`);
    const keyBody = await keyResponse.json() as { publicKey?: string };
    if (!keyBody.publicKey) throw new Error('Reminder key was missing.');

    const serverKey = applicationServerKey(keyBody.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    const subscribedKey = subscription?.options.applicationServerKey;
    if (subscription && subscribedKey && !sameBytes(subscribedKey, serverKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      });
    }

    const response = await authenticatedFetch('/push/sync', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: currentDeviceId,
        subscription: subscription.toJSON(),
        reminders: reminders.slice(0, 64).map((reminder) => ({
          id: reminder.id,
          title: reminder.title,
          body: reminder.body,
          at: reminder.at.getTime(),
          url: reminder.kind === 'deadline' ? '/tasks' : '/schedule',
        })),
      }),
    });
    if (!response.ok) throw new Error(`Reminder sync returned ${response.status}.`);
    return 'ready';
  } catch (error) {
    console.error('[reminders] Background sync failed.', error);
    return 'error';
  }
}

export async function removeBackgroundReminders(): Promise<void> {
  if (!R2_WORKER_URL || Platform.OS !== 'web') return;
  const user = getFirebaseAuth().currentUser;
  if (!user || user.isAnonymous) return;
  try {
    const response = await authenticatedFetch('/push/device', {
      method: 'DELETE',
      body: JSON.stringify({ deviceId: deviceId() }),
    });
    if (!response.ok) throw new Error(`Reminder removal returned ${response.status}.`);
  } catch (error) {
    console.warn('[reminders] Could not remove the background reminder queue.', error);
  }
}

/**
 * Deliver a message alert through the same per-device notification channel as
 * reminders. Messaging never depends on this call: a failed push does not
 * roll back the Firestore message the recipient can read when they return.
 */
export async function sendMessageNotification(input: {
  recipientId: string;
  conversationId: string;
  senderName: string;
  preview: string;
}): Promise<void> {
  if (!R2_WORKER_URL || Platform.OS !== 'web') return;
  const user = getFirebaseAuth().currentUser;
  if (!user || user.isAnonymous) return;
  try {
    const response = await authenticatedFetch('/push/message', {
      method: 'POST',
      body: JSON.stringify({
        recipientId: input.recipientId,
        conversationId: input.conversationId,
        title: input.senderName.slice(0, 80),
        body: input.preview.slice(0, 180),
      }),
    });
    if (!response.ok && response.status !== 404) {
      console.warn(`[messages] Notification returned ${response.status}.`);
    }
  } catch (error) {
    console.warn('[messages] Notification delivery failed.', error);
  }
}

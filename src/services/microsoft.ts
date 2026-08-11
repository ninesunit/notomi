import { Platform } from 'react-native';

/**
 * Microsoft 365, connected from the browser and nowhere else.
 *
 * Two decisions shape this file.
 *
 * The first is PKCE with no client secret. A student's university tenant is not
 * ours to hold credentials for, and a single-page app cannot keep a secret
 * anyway — anything shipped in the bundle is public. The authorisation code
 * flow with a proof key gives the same security without one.
 *
 * The second is where the tokens live: this device, in local storage, and not
 * in the database. Syncing them would make them readable wherever the account
 * is readable, which quietly turns a database compromise into a Microsoft
 * account compromise. The cost is that connecting is per-device. That is the
 * right trade, and the UI says so plainly.
 */

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Set at build time from an app registration in the Microsoft Entra portal.
 * Absent, every entry point to this feature stays hidden rather than failing.
 */
export const MS_CLIENT_ID = process.env.EXPO_PUBLIC_MS_CLIENT_ID ?? '';

/**
 * Least privilege, and each scope earns its place:
 * - Calendars.ReadWrite — write classes out, read a professor's changes back.
 * - EduAssignments.ReadBasic — assignments without submissions or grades.
 * - offline_access — the refresh token, so a background pull needs no prompt.
 */
const SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Calendars.ReadWrite',
  'EduAssignments.ReadBasic',
];

const STORE_KEY = 'notomi.ms.tokens';
const VERIFIER_KEY = 'notomi.ms.verifier';
const RETURN_KEY = 'notomi.ms.return';

type Tokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. Refreshed a minute early to survive a slow request. */
  expiresAt: number;
  account: string | null;
};

export function isConfigured(): boolean {
  return Platform.OS === 'web' && MS_CLIENT_ID.length > 0;
}

/* ------------------------------------------------------------------ *
 * Token storage
 * ------------------------------------------------------------------ */

function readTokens(): Tokens | null {
  if (Platform.OS !== 'web') return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

function writeTokens(tokens: Tokens | null): void {
  if (Platform.OS !== 'web') return;
  try {
    if (tokens) window.localStorage.setItem(STORE_KEY, JSON.stringify(tokens));
    else window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* Private browsing. The connection simply will not persist. */
  }
}

export function isConnected(): boolean {
  const tokens = readTokens();
  return Boolean(tokens && (tokens.refreshToken || tokens.expiresAt > Date.now()));
}

export function connectedAccount(): string | null {
  return readTokens()?.account ?? null;
}

export function disconnect(): void {
  writeTokens(null);
  try {
    window.localStorage.removeItem('notomi.ms.calendar');
    window.localStorage.removeItem('notomi.ms.delta');
  } catch {
    /* Nothing to clean up. */
  }
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

function randomVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The page Microsoft returns to. Must match a redirect URI on the app registration. */
export function redirectUri(): string {
  return `${window.location.origin}/connections`;
}

/**
 * Sends the browser to Microsoft. Returns only if something is misconfigured;
 * otherwise the page navigates away and the answer arrives at /connections.
 */
export async function beginConnect(returnTo = '/connections'): Promise<void> {
  if (!isConfigured()) throw new Error('Microsoft 365 is not set up for this build.');

  const verifier = randomVerifier();
  window.sessionStorage.setItem(VERIFIER_KEY, verifier);
  window.sessionStorage.setItem(RETURN_KEY, returnTo);

  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    // Personal accounts have no education data, but plenty of students use one
    // for their calendar. Letting them choose beats guessing the wrong tenant.
    prompt: 'select_account',
  });

  window.location.assign(`${AUTHORITY}/authorize?${params.toString()}`);
}

/**
 * Completes the flow on the page Microsoft redirected back to.
 *
 * Returns null when there is no code in the URL, which is the normal case for
 * anyone simply opening the screen.
 */
export async function completeConnect(): Promise<{ account: string | null } | null> {
  if (Platform.OS !== 'web') return null;

  const query = new URLSearchParams(window.location.search);
  const error = query.get('error_description') ?? query.get('error');
  const code = query.get('code');
  if (!code) {
    if (error) throw new Error(error);
    return null;
  }

  const verifier = window.sessionStorage.getItem(VERIFIER_KEY);
  window.sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error('That sign-in started somewhere else. Try connecting again.');

  const tokens = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });

  // The code is single-use and has no business staying in the address bar or
  // in the back-button history.
  window.history.replaceState({}, '', window.location.pathname);

  const account = await fetchAccountName(tokens.accessToken);
  writeTokens({ ...tokens, account });
  return { account };
}

async function exchange(fields: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      scope: SCOPES.join(' '),
      ...fields,
    }).toString(),
  });

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'Microsoft turned that down.');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    account: null,
  };
}

/** A live access token, refreshed if the stored one is spent. */
async function accessToken(): Promise<string> {
  const stored = readTokens();
  if (!stored) throw new Error('Not connected to Microsoft 365.');

  // A minute of headroom: a token that expires mid-request is a failed sync.
  if (stored.expiresAt - 60_000 > Date.now()) return stored.accessToken;
  if (!stored.refreshToken) {
    writeTokens(null);
    throw new Error('That connection expired. Connect again.');
  }

  try {
    const refreshed = await exchange({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    });
    // Microsoft rotates refresh tokens; keeping the old one guarantees a
    // failure on the request after next.
    writeTokens({
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? stored.refreshToken,
      account: stored.account,
    });
    return refreshed.accessToken;
  } catch (caught) {
    // A revoked grant is permanent — clearing it turns a confusing loop of
    // errors into a single "connect again".
    writeTokens(null);
    throw caught;
  }
}

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

export async function graph<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = await accessToken();
  const response = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ??
      `Microsoft 365 returned ${response.status}.`;
    throw new Error(message);
  }
  return payload as T;
}

/** Follows @odata.nextLink so a long list is not silently truncated at 10. */
export async function graphAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = path;
  let pages = 0;

  while (next && pages < 20) {
    const page: { value?: T[]; '@odata.nextLink'?: string } = await graph(next);
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'] ?? null;
    pages += 1;
  }
  return items;
}

async function fetchAccountName(token: string): Promise<string | null> {
  try {
    const response = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const me = (await response.json()) as { userPrincipalName?: string; displayName?: string };
    return me.userPrincipalName ?? me.displayName ?? null;
  } catch {
    return null;
  }
}

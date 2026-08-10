import { Platform } from 'react-native';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { getAI, getGenerativeModel, GoogleAIBackend, type AI, type GenerativeModel } from 'firebase/ai';

/**
 * Config comes from EXPO_PUBLIC_* env vars, which Expo inlines at build time.
 * Publishing these in the bundle is expected: Firebase web config identifies
 * the project, it does not grant access. Authorization is enforced by
 * firestore.rules and by restricting the API key to your hosting domains in
 * the Google Cloud console.
 */
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'appId'] as const;

export const missingFirebaseConfigKeys: string[] = REQUIRED_KEYS.filter(
  (key) => !firebaseConfig[key]
).map((key) => `EXPO_PUBLIC_FIREBASE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);

export const isFirebaseConfigured = missingFirebaseConfigKeys.length === 0;

export const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Point Auth/Firestore at `firebase emulators:start` instead of the live
 * project. AI Logic always calls the real service — there is no local Gemini
 * emulator.
 */
const USE_EMULATORS = process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATORS === '1';
const EMULATOR_HOST = process.env.EXPO_PUBLIC_EMULATOR_HOST || '127.0.0.1';

/** reCAPTCHA v3 site key from Firebase console > App Check > Apps > Web. */
const APP_CHECK_SITE_KEY = process.env.EXPO_PUBLIC_APP_CHECK_SITE_KEY ?? '';

/**
 * Everything below is lazily created so that an unconfigured build still boots
 * and can render the setup screen instead of throwing at import time.
 */
let appRef: FirebaseApp | null = null;
let authRef: Auth | null = null;
let dbRef: Firestore | null = null;
let aiRef: AI | null = null;
let appCheckRef: AppCheck | null = null;
let modelRef: GenerativeModel | null = null;

function assertConfigured(): void {
  if (!isFirebaseConfigured) {
    throw new Error(
      `Firebase is not configured. Missing: ${missingFirebaseConfigKeys.join(', ')}. ` +
        'Copy .env.example to .env and fill in the values from the Firebase console.'
    );
  }
}

/* ------------------------------------------------------------------ *
 * App Check
 * ------------------------------------------------------------------ */

/**
 * App Check attests that requests come from your real app.
 *
 * It is opt-in via EXPO_PUBLIC_APP_CHECK_SITE_KEY, and deliberately so:
 * calling initializeAppCheck without a registered reCAPTCHA site key makes
 * every attested request fail, so enabling it unconditionally would take the
 * whole app down rather than harden it. Register the site under
 * Firebase console > App Check first, then set the key.
 */
function setUpAppCheck(app: FirebaseApp): void {
  if (appCheckRef || Platform.OS !== 'web' || !APP_CHECK_SITE_KEY) return;

  // The debug provider issues a token that only works for debug registrations.
  // It must never reach production: anyone holding a debug token bypasses App
  // Check entirely, which is the one thing App Check exists to prevent.
  if (__DEV__) {
    (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      true;
  }

  try {
    appCheckRef = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (error) {
    // A misconfigured App Check must not stop the app from loading; the
    // affected calls will surface their own errors.
    console.warn('[firebase] App Check failed to initialize:', error);
  }
}

export const isAppCheckEnabled = (): boolean => appCheckRef !== null;

/* ------------------------------------------------------------------ *
 * Core services
 * ------------------------------------------------------------------ */

export function getFirebaseApp(): FirebaseApp {
  assertConfigured();
  if (!appRef) {
    appRef = getApps().length
      ? getApp()
      : initializeApp(firebaseConfig as Required<typeof firebaseConfig>);
    setUpAppCheck(appRef);
  }
  return appRef;
}

export function getFirebaseAuth(): Auth {
  if (!authRef) {
    const app = getFirebaseApp();
    if (Platform.OS === 'web') {
      authRef = initializeAuth(app, {
        // Keep the session across reloads and iOS Safari tab restores.
        persistence: [indexedDBLocalPersistence, browserLocalPersistence],
        // Required. getAuth() wires this up for you, but initializeAuth does
        // not — and without it signInWithPopup, signInWithRedirect and
        // getRedirectResult all fail with auth/argument-error, which is
        // exactly how Google sign-in broke.
        popupRedirectResolver: browserPopupRedirectResolver,
      });
    } else {
      authRef = getAuth(app);
    }
    if (USE_EMULATORS) {
      connectAuthEmulator(authRef, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
    }
  }
  return authRef;
}

export function getDb(): Firestore {
  if (!dbRef) {
    dbRef = getFirestore(getFirebaseApp());
    if (USE_EMULATORS) connectFirestoreEmulator(dbRef, EMULATOR_HOST, 8080);
  }
  return dbRef;
}

/**
 * Original files live in Cloudflare R2 (see src/services/r2Storage.ts), not
 * Firebase Storage, so no bucket handle is exported here.
 */

/* ------------------------------------------------------------------ *
 * Firebase AI Logic
 * ------------------------------------------------------------------ */

/**
 * Firebase AI Logic with the Gemini Developer API backend. The Firebase
 * project brokers the call, so no Gemini/OpenAI/Anthropic key ever ships in
 * the client.
 */
export function getAiClient(): AI {
  if (!aiRef) aiRef = getAI(getFirebaseApp(), { backend: new GoogleAIBackend() });
  return aiRef;
}

/**
 * The shared generative model every AI service goes through.
 *
 * Summaries, quiz generation and chat all call `model.generateContent(prompt)`
 * on this instance (or a per-call variant built from the same AI client in
 * src/lib/ai.ts when a response schema or system instruction is needed).
 */
export function getModel(): GenerativeModel {
  if (!modelRef) {
    modelRef = getGenerativeModel(getAiClient(), { model: GEMINI_MODEL });
  }
  return modelRef;
}

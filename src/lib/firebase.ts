import { Platform } from 'react-native';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';

/**
 * Config comes from EXPO_PUBLIC_* env vars, which Expo inlines at build time.
 * Publishing these in the bundle is expected: Firebase web config identifies
 * the project, it does not grant access. Authorization is enforced by
 * firestore.rules / storage.rules and by restricting the API key to your
 * hosting domains in the Google Cloud console.
 */
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'appId'] as const;

export const missingFirebaseConfigKeys: string[] = REQUIRED_KEYS.filter(
  (key) => !firebaseConfig[key]
).map((key) => `EXPO_PUBLIC_FIREBASE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);

export const isFirebaseConfigured = missingFirebaseConfigKeys.length === 0;

export const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Everything below is lazily created so that an unconfigured build still boots
 * and can render the setup screen instead of throwing at import time.
 */
let appRef: FirebaseApp | null = null;
let authRef: Auth | null = null;
let dbRef: Firestore | null = null;
let storageRef: FirebaseStorage | null = null;
let aiRef: AI | null = null;

function assertConfigured(): void {
  if (!isFirebaseConfigured) {
    throw new Error(
      `Firebase is not configured. Missing: ${missingFirebaseConfigKeys.join(', ')}. ` +
        'Copy .env.example to .env and fill in the values from the Firebase console.'
    );
  }
}

export function getFirebaseApp(): FirebaseApp {
  assertConfigured();
  if (!appRef) {
    appRef = getApps().length
      ? getApp()
      : initializeApp(firebaseConfig as Required<typeof firebaseConfig>);
  }
  return appRef;
}

export function getFirebaseAuth(): Auth {
  if (!authRef) {
    const app = getFirebaseApp();
    if (Platform.OS === 'web') {
      // Keep the session across reloads and across iOS Safari tab restores.
      authRef = initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence],
      });
    } else {
      authRef = getAuth(app);
    }
  }
  return authRef;
}

export function getDb(): Firestore {
  if (!dbRef) dbRef = getFirestore(getFirebaseApp());
  return dbRef;
}

export function getBucket(): FirebaseStorage {
  if (!storageRef) storageRef = getStorage(getFirebaseApp());
  return storageRef;
}

/**
 * Firebase AI Logic with the Gemini Developer API backend. The Firebase
 * project brokers the call, so no Gemini/OpenAI/Anthropic key ever ships in
 * the client.
 */
export function getAiClient(): AI {
  if (!aiRef) aiRef = getAI(getFirebaseApp(), { backend: new GoogleAIBackend() });
  return aiRef;
}

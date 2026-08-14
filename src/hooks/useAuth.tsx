import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  deleteUser,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  setPersistence,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDb, getFirebaseAuth, isFirebaseConfigured } from '@/services/firebase';
import { deleteGuestWorkspace } from '@/services/guestCleanup';

type AuthValue = {
  user: User | null;
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  logOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

function isClosingDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is closing\/hidden|indexeddb.*(?:closing|closed)|transaction.*inactive/i.test(
    message
  );
}

/** Retry once without IndexedDB when iPadOS restores a stale Auth database. */
async function withPersistenceRecovery<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (Platform.OS !== 'web' || !isClosingDatabaseError(error)) throw error;
    await setPersistence(getFirebaseAuth(), browserLocalPersistence);
    return action();
  }
}

/** Maps Firebase's error codes onto something a student can act on. */
export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address does not look right.';
    case 'auth/missing-password':
      return 'Enter your password.';
    case 'auth/weak-password':
      return 'Passwords need to be at least 6 characters.';
    case 'auth/email-already-in-use':
      return 'That email already has an account. Try signing in.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not switched on for this app.';
    case 'auth/admin-restricted-operation':
      return 'Guest sign-in is not switched on for this app.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google sign-in was cancelled.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google popup. Allow popups for this site, or try again.';
    case 'auth/unauthorized-domain':
      return 'Google sign-in is not available on this address.';
    case 'auth/account-exists-with-different-credential':
      return 'That email already has an account created with a different sign-in method.';
    default:
      return error instanceof Error ? error.message : 'Something went wrong. Try again.';
  }
}

/** Keeps a users/{uid} profile doc so rules and future features have an anchor. */
async function ensureProfile(user: User): Promise<void> {
  try {
    await setDoc(
      doc(getDb(), 'users', user.uid),
      {
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        isAnonymous: user.isAnonymous,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch {
    // A missing profile doc must never block sign-in.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setInitializing(false);
      return;
    }

    // Completes a signInWithRedirect that bounced through Google. Harmless
    // when there is no pending redirect.
    void getRedirectResult(getFirebaseAuth()).catch(() => undefined);

    return onAuthStateChanged(getFirebaseAuth(), (next) => {
      setUser(next);
      setInitializing(false);
      if (next) void ensureProfile(next);
    });
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      initializing,
      signIn: async (email, password) => {
        await withPersistenceRecovery(() =>
          signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password)
        );
      },
      signUp: async (email, password, displayName) => {
        const credential = await withPersistenceRecovery(() =>
          createUserWithEmailAndPassword(getFirebaseAuth(), email.trim(), password)
        );
        const name = displayName.trim();
        if (name) await updateProfile(credential.user, { displayName: name });
        await ensureProfile(credential.user);
      },
      signInWithGoogle: async () => {
        const auth = getFirebaseAuth();
        const provider = new GoogleAuthProvider();
        // Always show the chooser rather than silently reusing one Google
        // session — students often have a personal and a university account.
        provider.setCustomParameters({ prompt: 'select_account' });

        if (Platform.OS !== 'web') {
          // Native builds have no popup; the redirect flow is the only option.
          await signInWithRedirect(auth, provider);
          return;
        }

        try {
          await withPersistenceRecovery(() => signInWithPopup(auth, provider));
        } catch (error) {
          const code = (error as { code?: string }).code ?? '';
          // Popups are blocked outright in some in-app browsers and iOS
          // configurations; fall back rather than dead-ending the sign-in.
          if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
            await signInWithRedirect(auth, provider);
            return;
          }
          throw error;
        }
      },
      continueAsGuest: async () => {
        await withPersistenceRecovery(() => signInAnonymously(getFirebaseAuth()));
      },
      logOut: async () => {
        const auth = getFirebaseAuth();
        const current = auth.currentUser;
        if (current?.isAnonymous) {
          try {
            await deleteGuestWorkspace(current.uid);
            await deleteUser(current);
          } catch (error) {
            console.error('[auth] Temporary guest cleanup failed; keeping the session signed in.', error);
            throw new Error(
              'Your temporary data could not be deleted, so Notomi kept you signed in. Check your connection and try again.'
            );
          }
          return;
        }
        await signOut(auth);
      },
    }),
    [user, initializing]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Convenience for screens that are already behind the auth gate. */
export function useUid(): string {
  const { user } = useAuth();
  if (!user) throw new Error('useUid called outside the authenticated workspace');
  return user.uid;
}

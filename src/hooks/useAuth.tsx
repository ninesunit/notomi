import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDb, getFirebaseAuth, isFirebaseConfigured } from '@/lib/firebase';

type AuthValue = {
  user: User | null;
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  logOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

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
      return 'This sign-in method is disabled. Enable it in Firebase console > Authentication > Sign-in method.';
    case 'auth/admin-restricted-operation':
      return 'Anonymous sign-in is disabled. Enable it in Firebase console > Authentication > Sign-in method.';
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
        await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
      },
      signUp: async (email, password, displayName) => {
        const credential = await createUserWithEmailAndPassword(
          getFirebaseAuth(),
          email.trim(),
          password
        );
        const name = displayName.trim();
        if (name) await updateProfile(credential.user, { displayName: name });
        await ensureProfile(credential.user);
      },
      continueAsGuest: async () => {
        await signInAnonymously(getFirebaseAuth());
      },
      logOut: async () => {
        await signOut(getFirebaseAuth());
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

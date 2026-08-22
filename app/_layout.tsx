import { useEffect } from 'react';
import { useTones } from '@/components/Icon';
import { ActivityIndicator, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { SetupScreen } from '@/components/SetupScreen';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { registerServiceWorker } from '@/services/appUpdate';
import { trackFocusedInputs, trackViewportHeight } from '@/lib/viewport';
import { useTheme } from '@/lib/theme';
import { CrashScreen } from '@/components/CrashScreen';
import { isFirebaseConfigured } from '@/services/firebase';
import '../global.css';

function Splash() {
  const tones = useTones();
  return (
    <View className="flex-1 items-center justify-center bg-paper">
      <ActivityIndicator color={tones.accent} />
    </View>
  );
}

/** Keeps the URL and the session in sync in both directions. */
function AuthGate() {
  const { user, initializing } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  const inAuthGroup = segments[0] === '(auth)';
  // On a cold load the router mounts the route for the current URL before the
  // redirect below can run. Rendering the workspace in that window would call
  // useUid() with no session and throw, so the mismatch is held on a splash
  // until the URL and the session agree.
  const mismatched = initializing || (!user && !inAuthGroup) || (!!user && inAuthGroup);

  useEffect(() => {
    if (initializing) return;
    if (!user && !inAuthGroup) router.replace('/login');
    else if (user && inAuthGroup) router.replace('/dashboard');
  }, [user, initializing, inAuthGroup, router]);

  if (mismatched) return <Splash />;

  return <Slot />;
}

/**
 * Expo Router renders this instead of a blank page when a screen throws.
 *
 * Exported from the root layout so it covers every route: a crash in the
 * timetable, the canvas or a document reader all land here rather than
 * whiting out the tab. This is the difference between "Notomi broke" and
 * "Notomi is gone", and only one of those is recoverable by the student.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
  // Logged as well as shown: the screenshot a student sends will have the
  // message, but the console has the whole stack.
  console.error('[notomi] A screen crashed.', error);
  return <CrashScreen error={error} retry={retry} />;
}

export default function RootLayout() {
  // The document is already painted with the right palette by the inline script
  // in index.html; this is what keeps the native status bar in step with it.
  const theme = useTheme();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });

  // Registered once, at the top of the tree: an installed home-screen app has
  // no other moment where it reliably checks whether a deploy has landed.
  useEffect(() => registerServiceWorker(), []);

  // Bound to the visible viewport rather than the layout one, so the iOS
  // keyboard shortens the app instead of covering the bottom of it.
  useEffect(() => {
    const stopHeightTracking = trackViewportHeight();
    const stopFocusTracking = trackFocusedInputs();
    return () => {
      stopFocusTracking();
      stopHeightTracking();
    };
  }, []);

  /**
   * Promise rejections nobody awaited.
   *
   * These never reach the error boundary — the render succeeded, something
   * later just failed silently. A background sync that dies without a word is
   * precisely the kind of fault that gets described as "something is broken
   * but I cannot pinpoint it", so it gets written down with a tag that can be
   * searched for.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onRejection = (event: PromiseRejectionEvent) =>
      console.error('[notomi] Unhandled promise rejection.', event.reason);
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  useEffect(() => {
    if (fontError) console.error('[fonts] Brand font loading failed.', fontError);
  }, [fontError]);

  if (!fontsLoaded && !fontError) {
    return (
      <SafeAreaProvider>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <Splash />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      {isFirebaseConfigured ? (
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      ) : (
        <SetupScreen />
      )}
    </SafeAreaProvider>
  );
}

import { useEffect } from 'react';
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
import { trackViewportHeight } from '@/lib/viewport';
import { isFirebaseConfigured } from '@/services/firebase';
import '../global.css';

function Splash() {
  return (
    <View className="flex-1 items-center justify-center bg-paper">
      <ActivityIndicator color="#B4552D" />
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

export default function RootLayout() {
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
  useEffect(() => trackViewportHeight(), []);

  useEffect(() => {
    if (fontError) console.error('[fonts] Brand font loading failed.', fontError);
  }, [fontError]);

  if (!fontsLoaded && !fontError) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Splash />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
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

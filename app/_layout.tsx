import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SetupScreen } from '@/components/SetupScreen';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { isFirebaseConfigured } from '@/lib/firebase';
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
    else if (user && inAuthGroup) router.replace('/');
  }, [user, initializing, inAuthGroup, router]);

  if (mismatched) return <Splash />;

  return <Slot />;
}

export default function RootLayout() {
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

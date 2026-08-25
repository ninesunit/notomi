import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';

/**
 * Network state the browser already knows, with no polling and no backend
 * reads. The short recovery message confirms that queued manual work can be
 * retried instead of leaving the student wondering whether Wi-Fi returned.
 */
export function ConnectivityBanner() {
  const [online, setOnline] = useState(
    Platform.OS !== 'web' || typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wentOffline = () => {
      if (timer) clearTimeout(timer);
      setRecovered(false);
      setOnline(false);
    };
    const cameOnline = () => {
      setOnline(true);
      setRecovered(true);
      timer = setTimeout(() => setRecovered(false), 2400);
    };
    window.addEventListener('offline', wentOffline);
    window.addEventListener('online', cameOnline);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('offline', wentOffline);
      window.removeEventListener('online', cameOnline);
    };
  }, []);

  if (online && !recovered) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      className={`shrink-0 flex-row items-center gap-2 border-b border-line px-5 py-2.5 md:px-10 ${
        online ? 'bg-pine-soft' : 'bg-amber-soft'
      }`}
    >
      <Icon name={online ? 'wifi' : 'wifi-off'} size={15} tone={online ? 'pine' : 'amber'} />
      <Text className={`text-xs font-semibold ${online ? 'text-pine' : 'text-amber'}`}>
        {online
          ? 'Back online'
          : 'You are offline. Saved work stays available; uploads and AI will resume when you reconnect.'}
      </Text>
    </View>
  );
}

import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useUid } from '@/hooks/useAuth';
import { feedback } from '@/lib/sound';
import { backgroundPull } from '@/services/msSync';

/**
 * The background half of the Teams connection.
 *
 * It runs at most once every few hours and says nothing unless it found
 * something — but when it does add work to a student's list, it says so. Tasks
 * appearing in a to-do list without explanation is the kind of thing that makes
 * people stop trusting an app, and a line they can dismiss costs nothing.
 */
export function MicrosoftPull() {
  const uid = useUid();
  const [added, setAdded] = useState(0);

  useEffect(() => {
    let live = true;
    void backgroundPull(uid).then((pull) => {
      if (!live || !pull?.added) return;
      setAdded(pull.added);
      feedback('chime');
    });
    return () => {
      live = false;
    };
  }, [uid]);

  if (added === 0) return null;

  return (
    <View className="flex-row items-center gap-2.5 border-b border-line bg-pine-soft px-5 py-2.5">
      <Feather name="download" size={14} color="#2E6F5E" />
      <Text className="flex-1 text-[13px] text-ink">
        {added} new assignment{added === 1 ? '' : 's'} from Teams{' '}
        <Text className="text-muted">added to your tasks.</Text>
      </Text>
      <Link href="/todos" asChild>
        <Pressable accessibilityRole="link" className="rounded-lg bg-surface px-2.5 py-1">
          <Text className="text-xs font-semibold text-pine">View</Text>
        </Pressable>
      </Link>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={() => setAdded(0)}
        className="h-6 w-6 items-center justify-center"
      >
        <Feather name="x" size={14} color="#6F6A5F" />
      </Pressable>
    </View>
  );
}

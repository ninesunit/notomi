import { ScrollView, Text, View } from 'react-native';
import { Button } from './ui';
import { Logo } from './Logo';

/**
 * What a student sees when something throws.
 *
 * Until this existed, a render-time exception anywhere in the app produced a
 * blank white screen: no message, no way back, and nothing written down. That
 * is the worst possible failure mode for a study app, because it is
 * indistinguishable from the app being gone — and it is the reason a bug felt
 * unpinpointable rather than merely present.
 *
 * Three things matter here and nothing else does:
 *
 *   1. Say their work is safe, because it is. Everything is written to
 *      Firestore as it happens; a crashed screen has not lost a note.
 *   2. Offer the way out. Retry re-mounts the tree, which recovers the common
 *      case of a single screen tripping over bad data.
 *   3. Show the actual error. Not to the student's benefit — to the benefit of
 *      whoever they send the screenshot to. A crash nobody can describe is a
 *      crash nobody can fix.
 */
export function CrashScreen({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center bg-paper px-6">
      <View className="w-full max-w-md gap-5">
        <Logo size={40} />

        <View className="gap-2">
          <Text className="text-2xl font-bold tracking-tight text-ink">
            That screen stopped working
          </Text>
          <Text className="text-[15px] leading-6 text-muted">
            Your notes, files and schedule are safe — nothing here is stored on this screen.
            Try again, and if it keeps happening, send whoever maintains Notomi the details
            below.
          </Text>
        </View>

        <View className="flex-row flex-wrap gap-2">
          <Button label="Try again" icon="refresh-cw" onPress={retry} />
          <Button
            label="Back to dashboard"
            variant="secondary"
            onPress={() => {
              // A hard navigation, not a router push: the router itself may be
              // the thing that threw, and a push through a broken tree would
              // land right back here.
              if (typeof window !== 'undefined') window.location.assign('/dashboard');
            }}
          />
        </View>

        <ScrollView className="max-h-40 rounded-xl border border-line bg-surface p-3">
          <Text selectable className="text-xs leading-5 text-muted">
            {error?.message || 'Unknown error'}
            {error?.stack ? `\n\n${error.stack.split('\n').slice(0, 6).join('\n')}` : ''}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

import { ScrollView, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { missingFirebaseConfigKeys } from '@/services/firebase';

const STEPS = [
  'Copy .env.example to .env in the project root.',
  'Fill in the values for this deployment — see the project README for where each one comes from.',
  'Restart the dev server so the new .env is picked up.',
];

/**
 * Rendered instead of the app when EXPO_PUBLIC_FIREBASE_* values are absent, so
 * a fresh clone explains itself rather than throwing an SDK error.
 */
export function SetupScreen() {
  return (
    <ScrollView
      className="flex-1 bg-paper"
      contentContainerClassName="items-center px-6 py-16"
    >
      <View className="w-full max-w-2xl gap-6">
        <View className="gap-2">
          <View className="mb-2 h-11 w-11 items-center justify-center rounded-xl bg-ink">
            <Text className="text-lg font-bold text-paper">N</Text>
          </View>
          <Text className="text-3xl font-bold tracking-tight text-ink">Finish setting up Notomi</Text>
          <Text className="text-[15px] leading-6 text-muted">
            This deployment is missing its configuration, so the app cannot start. Add the values
            below and reload.
          </Text>
        </View>

        <View className="gap-3 rounded-2xl border border-line bg-surface p-5">
          <Text className="text-sm font-semibold text-ink">Missing environment variables</Text>
          <View className="gap-2">
            {missingFirebaseConfigKeys.map((key) => (
              <View key={key} className="flex-row items-center gap-2">
                <Icon name="x-circle" size={14} color="#B0443E" />
                <Text className="font-mono text-[13px] text-rose">{key}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className="gap-4 rounded-2xl border border-line bg-surface p-5">
          <Text className="text-sm font-semibold text-ink">Setup</Text>
          {STEPS.map((step, index) => (
            <View key={step} className="flex-row gap-3">
              <View className="h-6 w-6 items-center justify-center rounded-full bg-sand">
                <Text className="text-xs font-bold text-muted">{index + 1}</Text>
              </View>
              <Text className="flex-1 text-sm leading-6 text-ink/80">{step}</Text>
            </View>
          ))}
        </View>

        <Text className="text-xs leading-5 text-subtle">
          These values are safe to ship in a client bundle — they identify the project, they do not
          grant access. Every document is scoped to the account that created it.
        </Text>
      </View>
    </ScrollView>
  );
}

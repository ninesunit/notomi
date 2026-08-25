import { useState } from 'react';
import { Platform, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { Button, Card } from '@/components/ui';
import { usePWAInstall } from '@/hooks/usePWAInstall';

/**
 * A permanent route to installation, independent of semester onboarding.
 *
 * Chromium exposes a one-tap prompt. iOS deliberately does not, so Safari
 * receives an equally prominent four-step guide instead of a button that can
 * never work. This is browser capability detection, not user-agent guessing.
 */
export function InstallAppCard({ compact = false, showInstalled = false }: {
  compact?: boolean;
  showInstalled?: boolean;
}) {
  const install = usePWAInstall();
  const [help, setHelp] = useState(false);
  const [installing, setInstalling] = useState(false);

  if (Platform.OS !== 'web' || (install.installed && !showInstalled)) return null;

  const action = async () => {
    if (!install.canPrompt) {
      setHelp(true);
      return;
    }
    setInstalling(true);
    try {
      await install.install();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <Card className={`${compact ? 'mb-5 flex-row items-center' : 'mb-8'} gap-3`}>
        <View className="h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
          <Icon name={install.installed ? 'check-circle' : 'smartphone'} size={17} tone="accent" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-semibold text-ink">
            {install.installed ? 'Notomi is installed' : 'Install Notomi'}
          </Text>
          <Text className="text-xs leading-5 text-muted" numberOfLines={compact ? 2 : undefined}>
            {install.installed
              ? 'It opens full-screen from this device’s Home Screen or app launcher.'
              : 'Open Notomi full-screen with its own icon and faster access to your semester.'}
          </Text>
        </View>
        {install.installed ? null : (
          <Button
            label={install.canPrompt ? 'Install' : 'Show me'}
            icon={install.canPrompt ? 'arrow-down-to-line' : 'help-circle'}
            size="sm"
            variant={compact ? 'ghost' : 'secondary'}
            loading={installing}
            disabled={installing}
            onPress={() => void action()}
          />
        )}
      </Card>

      <Sheet
        visible={help}
        onClose={() => setHelp(false)}
        title="Add Notomi to this device"
        icon="smartphone"
        variant="compact"
      >
        <View className="gap-3">
          {(install.isIOS
            ? [
                ['Open in Safari', 'Installation is available from Safari’s browser controls.'],
                ['Open Share', 'Tap the Share button in Safari’s toolbar.'],
                ['Add to Home Screen', 'Scroll through the actions and select Add to Home Screen.'],
                ['Confirm Add', 'Launch Notomi from its new icon for the full-screen app.'],
              ]
            : [
                ['Open the browser menu', 'Use the menu beside the address bar.'],
                ['Choose Install app', 'It may be named Install Notomi or Add to Home screen.'],
                ['Confirm', 'Open Notomi from the new app icon when installation finishes.'],
              ]
          ).map(([title, body], index) => (
            <View key={title} className="flex-row items-start gap-3">
              <View className="h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink">
                <Text className="text-xs font-bold text-paper">{index + 1}</Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-ink">{title}</Text>
                <Text className="text-xs leading-5 text-muted">{body}</Text>
              </View>
            </View>
          ))}
        </View>
      </Sheet>
    </>
  );
}

import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * Google's branding guidelines require their own mark rather than a generic
 * icon, so the "G" is inlined as SVG — no network fetch, and it renders
 * identically on web, iOS and iPad.
 */
function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

export function GoogleButton({
  onPress,
  loading = false,
  disabled = false,
  label = 'Continue with Google',
}: {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      className={`flex-row items-center justify-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 ${
        isDisabled ? 'opacity-40' : ''
      }`}
    >
      {loading ? (
        <ActivityIndicator size="small" color="#1B1A17" />
      ) : (
        <View className="h-[18px] w-[18px] items-center justify-center">
          <GoogleMark />
        </View>
      )}
      <Text className="text-[15px] font-semibold text-ink">{label}</Text>
    </Pressable>
  );
}

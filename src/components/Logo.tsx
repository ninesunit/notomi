import Svg, { Path, Rect } from 'react-native-svg';

import { useTheme } from '@/lib/theme';

/**
 * The Notomi mark: an open academic workspace guided by one intelligent signal.
 *
 * The book establishes learning immediately, the short page strokes suggest
 * structured schedules and notes, and the terracotta signal identifies the AI
 * co-pilot. The drawing stays deliberately simple so it remains legible as a
 * 16 px favicon as well as a full-size app icon.
 */
export function Logo({ size = 32, tone }: { size?: number; tone?: 'ink' | 'paper' }) {
  // The mark is a tile, and a tile has to be able to be seen. Its dark ground
  // is within a shade of the dark theme's own surface, so on that ground the
  // tile would dissolve and leave the pages floating. Inverting by default is
  // how an app icon behaves on a dark home screen; an explicit tone still wins.
  const theme = useTheme();
  const resolved = tone ?? (theme === 'dark' ? 'paper' : 'ink');
  const surface = resolved === 'ink' ? '#1B1A17' : '#F7F5EE';
  const page = resolved === 'ink' ? '#F7F5EE' : '#1B1A17';
  const accent = '#B4552D';

  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <Rect width="32" height="32" rx="8.5" fill={surface} />

      <Path
        d="M6.5 11.6C9.6 11.1 12.8 12 16 14.4V24.8C13.2 22.7 10.2 22.3 6.5 22.7V11.6Z"
        fill={page}
      />
      <Path
        d="M25.5 11.6C22.4 11.1 19.2 12 16 14.4V24.8C18.8 22.7 21.8 22.3 25.5 22.7V11.6Z"
        fill={page}
      />

      <Path d="M16 14.4V24.8" stroke={surface} strokeWidth="1" strokeLinecap="round" />
      <Path
        d="M9.3 15.6L13.2 15.9M9.3 18.6L12.3 18.8M22.7 15.6L18.8 15.9M22.7 18.6L19.7 18.8"
        stroke={surface}
        strokeWidth="1.05"
        strokeLinecap="round"
      />

      <Path
        d="M16 4.6C16.3 6.8 17.4 7.9 19.6 8.2C17.4 8.5 16.3 9.6 16 11.8C15.7 9.6 14.6 8.5 12.4 8.2C14.6 7.9 15.7 6.8 16 4.6Z"
        fill={accent}
      />
    </Svg>
  );
}

import { Image, Text, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { TINT, subjectInk, subjectTint } from '@/lib/color';

/**
 * One student, drawn the same way everywhere.
 *
 * There were three of these — the profile page, a friend row and a public
 * profile — and they had already drifted: one applied `subjectInk` to the
 * initial and one used the raw stored colour, which on a dark background is
 * the difference between legible and invisible. Adding a fourth thing an
 * avatar can be (a chosen mark) to three separate components would have made
 * that worse, so there is one.
 */

/**
 * The marks a student can pick, and the only ones that render.
 *
 * Validated on the way out rather than trusted: an older account may hold a
 * name this build no longer ships, and an unknown icon should fall back to the
 * initial rather than crash the row it is in.
 */
export const AVATAR_ICONS: IconName[] = [
  'graduation-cap',
  'book-open',
  'atom',
  'flask-conical',
  'pen-tool',
  'coffee',
  'headphones',
  'rocket',
  'leaf',
  'moon-star',
  'cat',
  'palette',
];

const KNOWN = new Set<string>(AVATAR_ICONS);

export function avatarIconOf(icon: string | null | undefined): IconName | null {
  return icon && KNOWN.has(icon) ? (icon as IconName) : null;
}

export function Avatar({
  name,
  color,
  avatarUrl,
  icon,
  size = 48,
  statusColor,
}: {
  name: string;
  color: string;
  avatarUrl?: string | null;
  icon?: string | null;
  size?: number;
  /** A presence dot, when the viewer is allowed to see one. */
  statusColor?: string;
}) {
  const mark = avatarIconOf(icon);
  const dot = Math.max(10, Math.round(size * 0.28));

  return (
    <View>
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        />
      ) : (
        <View
          className="items-center justify-center"
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: subjectTint(color, TINT.fill),
          }}
        >
          {mark ? (
            <Icon name={mark} size={Math.round(size * 0.44)} color={subjectInk(color)} />
          ) : (
            <Text
              style={{
                fontSize: Math.round(size * 0.38),
                fontWeight: '700',
                color: subjectInk(color),
              }}
            >
              {(name || 'S').charAt(0).toUpperCase()}
            </Text>
          )}
        </View>
      )}
      {statusColor ? (
        <View
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-surface"
          style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: statusColor }}
        />
      ) : null}
    </View>
  );
}

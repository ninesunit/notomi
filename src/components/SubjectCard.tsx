import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import type { Subject } from '@/lib/schema';
import { FadeIn } from './motion';

/**
 * A subject folder tile.
 *
 * The card is tinted with the subject's own colour rather than left white, so
 * a library of eight folders reads as eight distinct places. Every coloured
 * surface is an in-flow View with a fixed height — nothing is absolutely
 * positioned, so a card can never paint outside its own bounds.
 */
export function SubjectCard({
  subject,
  onEdit,
}: {
  subject: Subject;
  onEdit?: () => void;
}) {
  const count = subject.documentCount ?? 0;
  const color = subject.color || '#B4552D';

  /**
   * The menu button is a sibling of the link, not a child of it.
   *
   * Nesting it inside <Link asChild> put it inside an <a> on web, so a tap
   * bubbled to the anchor and navigated a beat after the menu opened.
   * stopPropagation is not a reliable cure across react-native-web's synthetic
   * events and expo-router's own handler — removing the bubbling path is.
   */
  return (
    <View
      className="overflow-hidden rounded-2xl border border-line"
      style={{ backgroundColor: `${color}0F` }}
    >
      <View className="h-1.5 w-full" style={{ backgroundColor: color }} />

      <Link href={`/library/${subject.id}`} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${subject.name}`}
          className="gap-3.5 p-5"
        >
          <View className="flex-row items-start justify-between gap-3">
            <View
              className="h-11 w-11 items-center justify-center rounded-xl"
              style={{ backgroundColor: `${color}24` }}
            >
              {subject.emoji ? (
                <Text className="text-xl">{subject.emoji}</Text>
              ) : (
                <Feather name="book" size={18} color={color} />
              )}
            </View>

            {/* Space reserved for the overlaid menu button so the arrow never
                sits underneath it. */}
            <View className="flex-row items-center gap-1" style={{ paddingRight: onEdit ? 30 : 0 }}>
              <Feather name="arrow-up-right" size={16} color="#9A9488" />
            </View>
          </View>

          <View className="gap-1">
            {subject.moduleCode ? (
              <Text
                className="text-xs font-bold uppercase tracking-wider"
                style={{ color }}
                numberOfLines={1}
              >
                {subject.moduleCode}
              </Text>
            ) : null}
            <Text className="text-[17px] font-semibold leading-6 text-ink" numberOfLines={2}>
              {subject.name}
            </Text>
          </View>

          <View className="flex-row flex-wrap items-center gap-2">
            <View className="flex-row items-center gap-1.5">
              <Feather name="file-text" size={13} color="#9A9488" />
              <Text className="text-[13px] text-muted">
                {count} {count === 1 ? 'source' : 'sources'}
              </Text>
            </View>

            {subject.tag ? (
              <View
                className="rounded-full px-2 py-0.5"
                style={{ backgroundColor: `${color}24` }}
              >
                <Text className="text-[11px] font-semibold" style={{ color }}>
                  {subject.tag}
                </Text>
              </View>
            ) : null}

            {subject.grade ? (
              <View className="rounded-full bg-pine-soft px-2 py-0.5">
                <Text className="text-[11px] font-semibold text-pine">{subject.grade}</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      </Link>

      {onEdit ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${subject.name}`}
          hitSlop={10}
          onPress={onEdit}
          className="absolute right-3.5 top-6 h-8 w-8 items-center justify-center rounded-lg"
        >
          <Feather name="more-horizontal" size={16} color="#6F6A5F" />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Shared responsive grid. Cards wrap instead of overflowing on narrow screens. */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return <View className="flex-row flex-wrap gap-4">{children}</View>;
}

export function GridItem({
  children,
  minWidth = 260,
  maxWidth = 420,
  index = 0,
}: {
  children: React.ReactNode;
  minWidth?: number;
  maxWidth?: number;
  /** Position in the grid, used to stagger the entrance. */
  index?: number;
}) {
  // Capped as well as floored: without a ceiling a single subject stretches to
  // the full width of a desktop pane and stops reading as a card.
  return (
    <View className="flex-1 grow" style={{ minWidth, maxWidth, flexBasis: minWidth }}>
      <FadeIn index={index}>{children}</FadeIn>
    </View>
  );
}

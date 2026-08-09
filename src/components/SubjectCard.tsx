import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import type { Subject } from '@/lib/schema';

/**
 * A subject folder tile. The colour bar is an in-flow View with a fixed height
 * rather than an absolutely positioned background, so the card can never paint
 * outside its own bounds.
 */
export function SubjectCard({ subject }: { subject: Subject }) {
  const count = subject.documentCount ?? 0;

  return (
    <Link href={`/library/${subject.id}`} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${subject.name}`}
        className="overflow-hidden rounded-2xl border border-line bg-surface"
      >
        <View className="h-1.5 w-full" style={{ backgroundColor: subject.color || '#B4552D' }} />
        <View className="gap-3 p-5">
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1 gap-1">
              {subject.moduleCode ? (
                <Text className="text-xs font-bold uppercase tracking-wider text-accent">
                  {subject.moduleCode}
                </Text>
              ) : null}
              <Text className="text-[17px] font-semibold leading-6 text-ink" numberOfLines={2}>
                {subject.name}
              </Text>
            </View>
            <Feather name="arrow-up-right" size={16} color="#9A9488" />
          </View>

          <View className="flex-row items-center gap-1.5">
            <Feather name="file-text" size={13} color="#9A9488" />
            <Text className="text-[13px] text-muted">
              {count} {count === 1 ? 'source' : 'sources'}
            </Text>
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

/** Shared responsive grid. Cards wrap instead of overflowing on narrow screens. */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return <View className="flex-row flex-wrap gap-4">{children}</View>;
}

export function GridItem({ children, minWidth = 260 }: { children: React.ReactNode; minWidth?: number }) {
  return (
    <View className="flex-1 grow" style={{ minWidth, flexBasis: minWidth }}>
      {children}
    </View>
  );
}

import { Image, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { ScreenScroll } from '@/components/ScreenScroll';
import { SurfaceBack } from '@/components/SurfaceBack';
import { Button, Card, Loading, Notice, PageHeader } from '@/components/ui';
import { useDocument } from '@/hooks/useFirestore';
import { getDb } from '@/services/firebase';
import {
  normaliseProfileStats,
  profilePath,
  type Profile,
} from '@/services/social';
import { universityLabel } from '@/services/universities';

export default function PublicProfilePage() {
  const router = useRouter();
  const params = useLocalSearchParams<{ userId?: string | string[] }>();
  const userId = Array.isArray(params.userId) ? params.userId[0] : params.userId ?? '';
  const profile = useDocument<Profile>(profilePath(getDb(), userId || '__missing__'), [userId]);

  if (profile.loading) {
    return (
      <ScreenScroll maxWidth={760}>
        <Loading label="Opening student profile..." />
      </ScreenScroll>
    );
  }

  if (profile.error || !profile.data) {
    return (
      <ScreenScroll maxWidth={760}>
        <SurfaceBack href="/social" label="Back to Arena & Social" />
        <View className="mt-4">
          <Notice
            title="Profile unavailable"
            body={profile.error?.message || 'This student has not finished setting up a public profile.'}
          />
        </View>
      </ScreenScroll>
    );
  }

  const student = profile.data;
  const stats = normaliseProfileStats(student.stats);
  const courses = student.shareCourses ? (student.courseCodes ?? []).slice(0, 12) : [];
  const achievements = publicAchievements(stats);

  return (
    <ScreenScroll maxWidth={760}>
      <SurfaceBack href="/social" label="Back to Arena & Social" />
      <View className="mt-4" />
      <PageHeader
        title="Student profile"
        subtitle="Public academic identity, learning consistency and shared course connections."
        actions={
          <Button
            label="Challenge"
            icon="swords"
            onPress={() => router.push(`/social?tab=arena&opponent=${userId}` as never)}
          />
        }
      />

      <Card className="gap-6 p-6">
        <View className="flex-row flex-wrap items-center gap-5">
          <PublicAvatar profile={student} size={84} />
          <View className="min-w-[220px] flex-1 gap-1">
            <Text className="font-heading text-2xl font-bold tracking-tight text-ink">
              {student.displayName || 'Student'}
            </Text>
            <Text className="text-sm font-semibold text-accent">@{student.username}</Text>
            <Text className="text-sm text-muted">{student.major || 'Major not added'}</Text>
            {student.university ? (
              <Text className="text-xs font-medium text-subtle">{universityLabel(student)}</Text>
            ) : null}
          </View>
        </View>

        <View className="h-px bg-line" />
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Icon name="user" size={15} color="#6F6A5F" />
            <Text className="text-xs font-bold uppercase tracking-wider text-muted">Bio</Text>
          </View>
          <Text className="text-sm leading-6 text-ink">
            {student.bio || 'This student has not added a bio yet.'}
          </Text>
        </View>

        {courses.length ? (
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Icon name="book-open" size={15} color="#6F6A5F" />
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">Shared courses</Text>
            </View>
            <View className="flex-row flex-wrap gap-2">
              {courses.map((code) => (
                <View key={code} className="rounded-full bg-pine-soft px-3 py-1.5">
                  <Text className="text-xs font-semibold text-pine">{code}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </Card>

      <Card className="mt-5 gap-5 p-6">
        <View className="flex-row items-center gap-2">
          <Icon name="trending-up" size={17} color="#B4552D" />
          <Text className="font-heading text-lg font-semibold text-ink">Learning stats</Text>
        </View>
        <View className="flex-row flex-wrap gap-3">
          <PublicStat icon="layers" value={String(stats.masteredCards)} label="Cards mastered" />
          <PublicStat icon="timer" value={formatHours(stats.focusMinutes)} label="Focus time" />
          <PublicStat icon="flame" value={String(stats.currentStreak)} label="Day streak" />
          <PublicStat icon="trophy" value={String(stats.arenaWins)} label="Arena wins" />
        </View>
        <View className="h-px bg-line" />
        <View className="gap-2">
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">Achievements</Text>
          {achievements.length ? (
            <View className="flex-row flex-wrap gap-2">
              {achievements.map((label) => (
                <View key={label} className="flex-row items-center gap-2 rounded-full bg-amber-soft px-3 py-2">
                  <Icon name="award" size={14} color="#B4832A" />
                  <Text className="text-xs font-semibold text-ink">{label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text className="text-sm text-muted">No achievements unlocked yet.</Text>
          )}
        </View>
      </Card>
    </ScreenScroll>
  );
}

function PublicAvatar({ profile, size }: { profile: Profile; size: number }) {
  if (profile.avatarUrl) {
    return (
      <Image
        source={{ uri: profile.avatarUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  }
  const color = profile.avatarPreset || profile.color || '#B4552D';
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: `${color}24` }}
    >
      <Text className="font-heading text-2xl font-bold" style={{ color }}>
        {(profile.displayName || 'S').charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

function PublicStat({
  icon,
  value,
  label,
}: {
  icon: 'layers' | 'timer' | 'flame' | 'trophy';
  value: string;
  label: string;
}) {
  return (
    <View className="min-w-[130px] flex-1 rounded-xl bg-sand p-3">
      <Icon name={icon} size={15} color="#6F6A5F" />
      <Text className="mt-2 font-heading text-xl font-bold text-ink">{value}</Text>
      <Text className="mt-0.5 text-xs text-muted">{label}</Text>
    </View>
  );
}

function formatHours(minutes: number): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
  if (safeMinutes < 60) return `${safeMinutes}m`;
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function publicAchievements(stats: ReturnType<typeof normaliseProfileStats>): string[] {
  return [
    ...(stats.nightFocusMinutes >= 600 ? ['The Night Owl'] : []),
    ...(stats.perfectAttendanceMonth ? ['The Regular'] : []),
    ...(stats.arenaWins >= 50 ? ['Arena Champion'] : []),
    ...(stats.materialCount >= 20 ? ['Library Architect'] : []),
    ...(stats.masteredCards >= 100 ? ['Knowledge Keeper'] : []),
  ];
}

import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { DayFilter } from '@/components/DayFilter';
import { DriveConnect } from '@/components/DriveConnect';
import { lazyScreen } from '@/components/lazyScreen';
import { Icon, type IconName } from '@/components/Icon';
import { RemindersCard } from '@/components/Reminders';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, PageHeader, Touchable } from '@/components/ui';
import { WeekStyleToggle } from '@/components/WeekStyleToggle';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useQueryOnce } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { Semester } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { useVisibleDays } from '@/hooks/useVisibleDays';
import {
  ATTENDANCE_THRESHOLDS,
  GRADE_SCALES,
  GRADE_SCALE_IDS,
  useAttendanceThreshold,
  useGradeScale,
  type AttendanceThreshold,
  type GradeScaleId,
} from '@/lib/academicRules';
import { isDriveConfigured } from '@/lib/driveUtils';
import { play, soundPreference } from '@/lib/sound';
import { useThemeChoice, type ThemeChoice } from '@/lib/theme';
import { exportAcademicData } from '@/services/dataExport';
import { exportTermCalendar } from '@/services/calendarExport';
import { AI_LIMITS, budgetStatus, subscribeToBudget } from '@/lib/aiBudget';

// Opened once a term at most, and it drags the migration machinery with it.
const DriveMigrationModal = lazyScreen<{ visible: boolean; onClose: () => void }>(
  () => import('@/components/DriveMigrationModal'),
  'DriveMigrationModal',
  'Preparing…'
);

/**
 * Settings.
 *
 * The one screen where a list of settings is the right answer, which is exactly
 * why the settings that were scattered belong here: the week's shape, the rules
 * a university sets, reminders, sound, the account. Everything else in Notomi
 * earns its place by being on the way to something; this is the place a student
 * goes on purpose.
 *
 * Ordered by how often it is touched, not by how important it sounds. The look
 * of the app and the shape of the week change often; a grading scale is set
 * once a degree.
 */
export default function Settings() {
  const { user, logOut } = useAuth();
  const [sound, setSound] = soundPreference.use();
  const [theme, setTheme] = useThemeChoice();
  const [migrating, setMigrating] = useState(false);

  const displayName = user?.displayName || (user?.isAnonymous ? 'Guest' : user?.email) || 'You';

  return (
    <ScreenScroll>
      <PageHeader title="Settings" subtitle="How Notomi looks, works and remembers." />

      <SettingCard icon="sun" title="Appearance" subtitle="How Notomi looks on this device.">
        <Segment
          options={[
            { id: 'light', label: 'Light', icon: 'sun' },
            { id: 'dark', label: 'Dark', icon: 'moon' },
            { id: 'system', label: 'Match device', icon: 'monitor' },
          ]}
          value={theme}
          onChange={(next: ThemeChoice) => setTheme(next)}
        />
      </SettingCard>

      <WeekCard />

      <RemindersCard settingsOpen />

      <SoundCard
        sound={sound}
        onChange={(next) => {
          setSound(next);
          // Played after enabling so the switch confirms itself audibly.
          if (next) play('toggle');
        }}
      />

      <RulesCard />

      <AllowanceCard />

      <View className="mb-8 gap-2">
        <DriveConnect />
        {isDriveConfigured() ? (
          <Button
            label="Move existing files to my Drive"
            icon="upload-cloud"
            variant="secondary"
            size="sm"
            onPress={() => setMigrating(true)}
          />
        ) : null}
      </View>
      {migrating ? <DriveMigrationModal visible onClose={() => setMigrating(false)} /> : null}

      <DataCard />

      <Card className="mb-8 gap-4">
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
            <Text className="text-base font-bold text-accent">
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
              {displayName}
            </Text>
            <Text className="text-xs text-muted" numberOfLines={1}>
              {user?.isAnonymous ? 'Temporary guest account' : (user?.email ?? '')}
            </Text>
          </View>
        </View>

        {user?.isAnonymous ? (
          <Text className="text-xs leading-5 text-subtle">
            Signing out permanently deletes this guest account and everything stored in it. Create
            a regular account before adding work you need to keep.
          </Text>
        ) : null}

        <View className="flex-row">
          <Button
            label="Sign out"
            icon="log-out"
            variant="secondary"
            size="sm"
            onPress={() => {
              void logOut().catch((error) =>
                Alert.alert(
                  'Could not sign out',
                  error instanceof Error ? error.message : 'Try again.'
                )
              );
            }}
          />
        </View>
      </Card>

      <Card className="gap-2">
        <Text className="text-[15px] font-semibold text-ink">About Notomi</Text>
        <Text className="text-sm leading-6 text-muted">
          Your whole semester in one place. Scan your timetable once and Notomi builds your
          subjects, your week and your deadlines, then helps you study from your own material —
          notes, flashcards, a tutor that only knows what you uploaded.
        </Text>
        <Row label="Version" value="1.0.0" />
        <Text className="mt-2 text-xs leading-5 text-subtle">
          Notomi updates itself: a new version is fetched in the background and applied the next
          time you open it.
        </Text>
      </Card>
    </ScreenScroll>
  );
}

/* ---------------------------- Shared shapes ---------------------------- */

/**
 * The card every setting sits in. Extracted once there were five of them and
 * the header markup had started to differ by a pixel here and a tone there.
 */
function SettingCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="mb-8 gap-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name={icon} size={16} tone="muted" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">{title}</Text>
          <Text className="text-xs leading-4 text-muted">{subtitle}</Text>
        </View>
      </View>
      {children}
    </Card>
  );
}

/** One choice from a short list, as a row of pills. */
function Segment<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: T; label: string; icon?: IconName }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {options.map((option) => {
        const active = value === option.id;
        return (
          <Pressable
            key={String(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (active) return;
              play('toggle');
              onChange(option.id);
            }}
            className={`min-w-0 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 ${
              active ? 'bg-ink' : 'bg-sand'
            }`}
          >
            {option.icon ? (
              <Icon name={option.icon} size={14} tone={active ? 'inverse' : 'muted'} />
            ) : null}
            <Text
              className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------- Cards -------------------------------- */

/**
 * Both of these already exist on the timetable and the dashboard, where they
 * belong — a control that changes what you are looking at should sit next to
 * it. They are here as well because that is where a student looks for a
 * setting they cannot remember seeing, and both read the same store, so the
 * two places can never disagree.
 */
function WeekCard() {
  const { visibleDays, toggleDay } = useVisibleDays();

  return (
    <SettingCard
      icon="calendar"
      title="Your week"
      subtitle="How the week is drawn, and which days it includes."
    >
      <View className="flex-row items-center gap-2">
        <WeekStyleToggle />
        <DayFilter visibleDays={visibleDays} onToggle={toggleDay} className="flex-1" />
      </View>
    </SettingCard>
  );
}

/**
 * The two numbers Notomi cannot guess.
 *
 * Both were hardcoded to one institution's answer, so a student elsewhere was
 * shown numbers that were confidently wrong: how many classes they could still
 * miss, and what their GPA was. That is why this card exists rather than a
 * sensible default staying invisible.
 */
function RulesCard() {
  const [threshold, setThreshold] = useAttendanceThreshold();
  const [scaleId, setScaleId] = useGradeScale();

  return (
    <SettingCard
      icon="graduation-cap"
      title="Your university's rules"
      subtitle="Attendance and grading differ by institution. Notomi should use yours."
    >
      <View className="gap-2">
        <Text className="text-xs font-medium text-muted">Minimum attendance</Text>
        <Segment
          options={ATTENDANCE_THRESHOLDS.map((value) => ({ id: value, label: `${value}%` }))}
          value={threshold}
          onChange={(next: AttendanceThreshold) => setThreshold(next)}
        />
      </View>

      <View className="gap-2">
        <Text className="text-xs font-medium text-muted">Grade scale — what an A is worth</Text>
        <Segment
          options={GRADE_SCALE_IDS.map((id) => ({ id, label: GRADE_SCALES[id].label }))}
          value={scaleId}
          onChange={(next: GradeScaleId) => setScaleId(next)}
        />
        <Text className="text-[11px] leading-4 text-subtle">
          Changes what each letter is worth. Your recorded grades are untouched — an A stays an A.
        </Text>
      </View>
    </SettingCard>
  );
}

function SoundCard({ sound, onChange }: { sound: boolean; onChange: (next: boolean) => void }) {
  return (
    <Card className="mb-8 gap-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name={sound ? 'volume-2' : 'volume-x'} size={16} tone="muted" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Sound and haptics</Text>
          <Text className="text-xs text-muted">
            Short cues when something saves, finishes or fails.
          </Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: sound }}
          accessibilityLabel={sound ? 'Turn sound off' : 'Turn sound on'}
          onPress={() => onChange(!sound)}
          className={`h-7 w-12 justify-center rounded-full px-0.5 ${sound ? 'bg-pine' : 'bg-line'}`}
        >
          <View className={`h-6 w-6 rounded-full bg-surface ${sound ? 'self-end' : 'self-start'}`} />
        </Pressable>
      </View>
    </Card>
  );
}

/**
 * Leaving has to be possible.
 *
 * A study workspace accumulates a term of work, and a student who cannot get it
 * out is not using the app so much as stuck in it. The privacy switches are
 * linked rather than copied here: they are saved as part of the profile, and a
 * second write path for them is a second way to overwrite a bio by accident.
 */
function DataCard() {
  const uid = useUid();
  const [busy, setBusy] = useState<'data' | 'calendar' | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The calendar file describes one term, so there has to be one in force.
  const semesters = useQueryOnce<Semester>(paths.semesters(getDb(), uid), [uid]);
  const term = semesters.data.find((entry) => entry.isCurrent) ?? semesters.data[0] ?? null;

  return (
    <SettingCard
      icon="shield"
      title="Your data"
      subtitle="Take a copy, or change who can see what."
    >
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={busy === 'data' ? 'Collecting…' : 'Export everything as JSON'}
          icon="arrow-down-to-line"
          variant="secondary"
          size="sm"
          loading={busy === 'data'}
          disabled={busy !== null}
          onPress={() => {
            setBusy('data');
            setDone(null);
            void exportAcademicData(uid)
              .then((summary) => {
                setDone(`${summary.documents} records across ${summary.collections} collections.`);
                play('success');
              })
              .catch((error: unknown) =>
                Alert.alert(
                  'Could not export',
                  error instanceof Error ? error.message : 'Try again.'
                )
              )
              .finally(() => setBusy(null));
          }}
        />
        <Button
          label={busy === 'calendar' ? 'Building…' : 'Term as a calendar file'}
          icon="calendar"
          variant="secondary"
          size="sm"
          loading={busy === 'calendar'}
          disabled={busy !== null || !term}
          onPress={() => {
            if (!term) return;
            setBusy('calendar');
            setDone(null);
            void exportTermCalendar(uid, term)
              .then((summary) => {
                setDone(
                  `${summary.classes} weekly class${summary.classes === 1 ? '' : 'es'} and ${summary.deadlines} deadline${summary.deadlines === 1 ? '' : 's'}. Open it in any calendar app.`
                );
                play('success');
              })
              .catch((error: unknown) =>
                Alert.alert(
                  'Could not build the calendar',
                  error instanceof Error ? error.message : 'Try again.'
                )
              )
              .finally(() => setBusy(null));
          }}
        />
      </View>

      <Text className="text-[11px] leading-4 text-subtle">
        {done ??
          'JSON is everything: subjects, notes, flashcards, timetable, deadlines, teaching plans. The calendar file is this term’s classes and deadlines, for the calendar app you already use. Uploaded files stay where they are — in your own storage.'}
      </Text>

      <Link href="/profile" asChild>
        <Touchable
          accessibilityRole="link"
          accessibilityLabel="Privacy settings, in your profile"
          className="flex-row items-center gap-3 rounded-xl border border-line px-3 py-2.5"
        >
          <Icon name="eye" size={15} tone="muted" />
          <Text className="flex-1 text-sm font-medium text-ink">Who can see your courses</Text>
          <Icon name="chevron-right" size={15} tone="subtle" />
        </Touchable>
      </Link>
    </SettingCard>
  );
}

/**
 * What is left, and when it comes back.
 *
 * Notomi runs on free allowances that are shared across everyone using it, so
 * they are finite in a way a student has no other way to see. A number here is
 * the difference between "the AI is broken" and "I have used today's" — and
 * the second one tells you what to do about it.
 */
function AllowanceCard() {
  const [, bump] = useState(0);
  useEffect(() => subscribeToBudget(() => bump((value) => value + 1)), []);

  const status = budgetStatus();
  const blocked = status.blockedUntil;

  return (
    <SettingCard
      icon="activity"
      title="Today's AI allowance"
      subtitle="Shared across everyone using Notomi, so it resets rather than runs out for good."
    >
      <View className="flex-row gap-2">
        <Meter label="Questions" left={status.standardLeft} of={AI_LIMITS.standardPerDay} />
        <Meter label="File analyses" left={status.heavyLeft} of={AI_LIMITS.heavyPerDay} />
      </View>
      <Text className="text-[11px] leading-4 text-subtle">
        {blocked
          ? `The AI service has been failing, so Notomi has paused asking until ${blocked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Everything else still works.`
          : `Resets at midnight. Schedules, tasks, notes and anything already processed never depend on this.`}
      </Text>
    </SettingCard>
  );
}

function Meter({ label, left, of }: { label: string; left: number; of: number }) {
  const ratio = Math.max(0, Math.min(1, left / of));
  return (
    <View className="flex-1 gap-1.5 rounded-xl bg-sand p-3">
      <View className="flex-row items-baseline gap-1">
        <Text className="text-base font-bold text-ink">{left}</Text>
        <Text className="text-[11px] text-muted">of {of}</Text>
      </View>
      <Text className="text-[11px] text-muted" numberOfLines={1}>
        {label}
      </Text>
      <View className="h-1 overflow-hidden rounded-full bg-line">
        <View
          className={`h-full rounded-full ${ratio > 0.3 ? 'bg-pine' : ratio > 0 ? 'bg-amber' : 'bg-rose'}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between border-t border-line py-2">
      <Text className="text-sm text-muted">{label}</Text>
      <Text className="text-sm font-medium text-ink">{value}</Text>
    </View>
  );
}

import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { DayFilter } from '@/components/DayFilter';
import { DriveConnect } from '@/components/DriveConnect';
import { lazyScreen } from '@/components/lazyScreen';
import { Icon, type IconName } from '@/components/Icon';
import { RemindersCard } from '@/components/Reminders';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, Field, PageHeader, Touchable } from '@/components/ui';
import { WeekStyleToggle } from '@/components/WeekStyleToggle';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useQueryOnce } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { Semester } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { useVisibleDays } from '@/hooks/useVisibleDays';
import { useUISound } from '@/hooks/useUISound';
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
import { play } from '@/lib/sound';
import { useThemeChoice, type ThemeChoice } from '@/lib/theme';
import { exportAcademicData } from '@/services/dataExport';
import { exportTermCalendar } from '@/services/calendarExport';
import { myProfile, privacyOf, savePrivacy, type PrivacySettings } from '@/services/social';
import { SafetyRows } from '@/components/social/SafetyRows';
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
type GroupId = 'look' | 'week' | 'study' | 'privacy' | 'storage' | 'account';

/**
 * Six groups, and a search box over all of them.
 *
 * Settings had become one column eleven cards long. Everything in it was in
 * the right *app*, and nothing in it was findable: a student who wanted to
 * change their attendance rule had to scroll past reminders, sound and their
 * AI allowance to find out whether it was even there.
 *
 * Grouping alone would not have fixed that, because the hard case is not
 * "where is the sound setting" — it is "can I even change this". So the
 * keywords are the real feature: typing "dark", "75", "gpa", "delete" or
 * "blocked" finds the setting without knowing which drawer it lives in.
 */
const GROUPS: {
  id: GroupId;
  title: string;
  subtitle: string;
  icon: IconName;
  keywords: string;
}[] = [
  {
    id: 'look',
    title: 'Look and feel',
    subtitle: 'Theme and sound',
    icon: 'sun',
    keywords: 'appearance theme dark light mode colour color sound audio mute volume taps clicks',
  },
  {
    id: 'week',
    title: 'Your week',
    subtitle: 'Timetable style, visible days, class reminders',
    icon: 'calendar',
    keywords: 'week timetable grid list agenda days weekend hide reminders notifications alerts class',
  },
  {
    id: 'study',
    title: 'Study rules',
    subtitle: 'Attendance threshold, grading scale, AI allowance',
    icon: 'graduation-cap',
    keywords: 'attendance threshold percent 75 80 85 grade grading scale gpa points university rules ai allowance limit quota',
  },
  {
    id: 'privacy',
    title: 'Privacy and people',
    subtitle: 'Who can find you, blocked people, shared material',
    icon: 'eye',
    keywords: 'privacy public profile classmates discovery presence status schedule blocked block report shared material revoke friends preview',
  },
  {
    id: 'storage',
    title: 'Files and data',
    subtitle: 'Where originals live, and taking a copy',
    icon: 'shield',
    keywords: 'drive storage files originals upload migrate export json backup copy calendar ics download data',
  },
  {
    id: 'account',
    title: 'Account',
    subtitle: 'Sign out, and about Notomi',
    icon: 'user',
    keywords: 'account sign out log out email guest version about update',
  },
];

export default function Settings() {
  const { user, logOut } = useAuth();
  const uiSound = useUISound();
  const [theme, setTheme] = useThemeChoice();
  const [migrating, setMigrating] = useState(false);
  const [open, setOpen] = useState<GroupId | null>(null);
  const [search, setSearch] = useState('');

  const displayName = user?.displayName || (user?.isAnonymous ? 'Guest' : user?.email) || 'You';

  const query = search.trim().toLowerCase();
  const matches = query.length >= 2
    ? GROUPS.filter(
        (group) =>
          group.title.toLowerCase().includes(query) ||
          group.subtitle.toLowerCase().includes(query) ||
          group.keywords.includes(query)
      )
    : [];

  const section = (id: GroupId) => {
    switch (id) {
      case 'look':
        return (
          <>
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
            <SoundCard
              sound={uiSound.sound}
              volume={uiSound.volume}
              haptics={uiSound.haptics}
              onChange={(next) => {
                uiSound.setSound(next);
                // Played after enabling so the switch confirms itself audibly.
                if (next) play('toggle');
              }}
              onVolume={uiSound.setVolume}
              onHaptics={uiSound.setHaptics}
            />
          </>
        );
      case 'week':
        return (
          <>
            <WeekCard />
            <RemindersCard settingsOpen />
          </>
        );
      case 'study':
        return (
          <>
            <RulesCard />
            <AllowanceCard />
          </>
        );
      case 'privacy':
        return <PrivacyCard />;
      case 'storage':
        return (
          <>
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
            <DataCard />
          </>
        );
      case 'account':
        return (
          <>
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
                  Signing out permanently deletes this guest account and everything stored in it.
                  Create a regular account before adding work you need to keep.
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
                subjects, your week and your deadlines, then helps you study from your own material
                — notes, flashcards, a tutor that only knows what you uploaded.
              </Text>
              <Row label="Version" value="1.0.0" />
              <Text className="mt-2 text-xs leading-5 text-subtle">
                Notomi updates itself: a new version is fetched in the background and applied the
                next time you open it.
              </Text>
            </Card>
          </>
        );
    }
  };

  const current = open ? GROUPS.find((group) => group.id === open) : null;

  return (
    <ScreenScroll maxWidth={760}>
      {current ? (
        <>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Back to all settings"
            onPress={() => setOpen(null)}
            className="mb-3 flex-row items-center gap-1.5 self-start py-1"
          >
            <Icon name="arrow-left" size={16} tone="muted" />
            <Text className="text-sm font-medium text-muted">All settings</Text>
          </Touchable>
          <PageHeader title={current.title} subtitle={current.subtitle} />
          {section(current.id)}
        </>
      ) : (
        <>
          <PageHeader title="Settings" subtitle="How Notomi looks, works and remembers." />

          <View className="mb-6">
            <Field
              value={search}
              onChangeText={setSearch}
              placeholder="Search settings…"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Search settings"
            />
          </View>

          {query.length >= 2 ? (
            matches.length === 0 ? (
              <Card>
                <Text className="text-sm text-muted">
                  Nothing here matches “{search.trim()}”. Notomi keeps very little configuration on
                  purpose — if you expected a setting and it is not here, it probably does not exist
                  yet.
                </Text>
              </Card>
            ) : (
              <View className="gap-6">
                {matches.map((group) => (
                  <View key={group.id}>
                    <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">
                      {group.title}
                    </Text>
                    {section(group.id)}
                  </View>
                ))}
              </View>
            )
          ) : (
            <View className="gap-2">
              {GROUPS.map((group) => (
                <Touchable
                  key={group.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${group.title}. ${group.subtitle}.`}
                  onPress={() => setOpen(group.id)}
                  className="flex-row items-center gap-3 rounded-2xl border border-line bg-surface p-3.5"
                >
                  <View className="h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sand">
                    <Icon name={group.icon} size={17} tone="muted" />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-[15px] font-semibold text-ink">{group.title}</Text>
                    <Text className="text-xs text-muted" numberOfLines={2}>
                      {group.subtitle}
                    </Text>
                  </View>
                  <Icon name="chevron-right" size={16} tone="subtle" />
                </Touchable>
              ))}
            </View>
          )}
        </>
      )}

      {migrating ? <DriveMigrationModal visible onClose={() => setMigrating(false)} /> : null}
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

function SoundCard({
  sound,
  volume,
  haptics,
  onChange,
  onVolume,
  onHaptics,
}: {
  sound: boolean;
  volume: number;
  haptics: boolean;
  onChange: (next: boolean) => void;
  onVolume: (next: number) => void;
  onHaptics: (next: boolean) => void;
}) {
  return (
    <Card className="mb-8 gap-4">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name={sound ? 'volume-2' : 'volume-x'} size={16} tone="muted" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-semibold text-ink">Interface sound</Text>
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

      {sound ? (
        <View className="gap-2 border-t border-line pt-4">
          <Text className="text-xs font-medium text-muted">Cue volume</Text>
          <Segment
            options={[
              { id: 0.35, label: 'Quiet' },
              { id: 0.65, label: 'Balanced' },
              { id: 1, label: 'Clear' },
            ]}
            value={volume <= 0.45 ? 0.35 : volume >= 0.85 ? 1 : 0.65}
            onChange={onVolume}
          />
        </View>
      ) : null}

      <View className="flex-row items-center gap-3 border-t border-line pt-4">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
          <Icon name="smartphone" size={16} tone="muted" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">Touch feedback</Text>
          <Text className="text-xs text-muted">Short vibrations where the device supports them.</Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: haptics }}
          accessibilityLabel={haptics ? 'Turn touch feedback off' : 'Turn touch feedback on'}
          onPress={() => onHaptics(!haptics)}
          className={`h-7 w-12 justify-center rounded-full px-0.5 ${haptics ? 'bg-pine' : 'bg-line'}`}
        >
          <View className={`h-6 w-6 rounded-full bg-surface ${haptics ? 'self-end' : 'self-start'}`} />
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
/**
 * Who can see what, in the place a student looks for a setting.
 *
 * These three switches lived at the bottom of the profile *edit* form, which
 * meant changing what other people can see required opening a form about
 * yourself and scrolling past your bio. Worse, saving them went through the
 * whole-profile write, so a privacy change could fail with a message about a
 * username being taken.
 *
 * Each row says what it means for someone else rather than what it sets, which
 * is the difference between a toggle a student understands and one they leave
 * alone because they are not sure.
 */
function PrivacyCard() {
  const uid = useUid();
  const [privacy, setPrivacy] = useState<PrivacySettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void myProfile(uid)
      .then((profile) => active && setPrivacy(privacyOf(profile)))
      .catch(() => active && setPrivacy(privacyOf(null)));
    return () => {
      active = false;
    };
  }, [uid]);

  function update(patch: Partial<PrivacySettings>) {
    if (!privacy) return;
    const next = { ...privacy, ...patch };
    // Optimistic: the switch should move under the thumb, not after a
    // round trip. It goes back if the write fails.
    setPrivacy(next);
    setError(null);
    play('toggle');
    void savePrivacy(uid, next).catch(() => {
      setPrivacy(privacy);
      setError('That did not save. Check your connection and try again.');
    });
  }

  const rows: Array<{ key: keyof PrivacySettings; title: string; detail: string }> = [
    {
      key: 'shareCourses',
      title: 'Classmates can find you',
      detail: 'People taking the same courses can see that you share them, and send a request.',
    },
    {
      key: 'sharePresence',
      title: 'Friends see when you are studying',
      detail: 'Free, in class or focusing — never what you are working on unless you say so.',
    },
    {
      key: 'shareSchedule',
      title: 'Friends can match free time',
      detail: 'They see busy and free blocks. Course names, rooms and routines stay private.',
    },
  ];

  return (
    <SettingCard
      icon="eye"
      title="Privacy & social"
      subtitle="Everything here is off until you turn it on."
    >
      {privacy === null ? (
        <Text className="text-xs text-subtle">Checking…</Text>
      ) : (
        <View className="gap-1">
          {rows.map((row) => (
            <View key={row.key} className="flex-row items-center gap-3 py-2">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-sm font-medium text-ink">{row.title}</Text>
                <Text className="text-[11px] leading-4 text-muted">{row.detail}</Text>
              </View>
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: privacy[row.key] }}
                accessibilityLabel={`${row.title}. ${privacy[row.key] ? 'On' : 'Off'}.`}
                onPress={() => update({ [row.key]: !privacy[row.key] })}
                className={`h-7 w-12 shrink-0 justify-center rounded-full px-0.5 ${
                  privacy[row.key] ? 'bg-pine' : 'bg-line'
                }`}
              >
                <View
                  className={`h-6 w-6 rounded-full bg-surface ${
                    privacy[row.key] ? 'self-end' : 'self-start'
                  }`}
                />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {error ? <Text className="text-[11px] text-rose">{error}</Text> : null}

      {/*
        The switches say what will happen. These say what already has — and a
        student who has just turned something off is exactly the person who
        wants to check who already has a copy.
      */}
      <View className="mt-1 h-px bg-line" />
      <SafetyRows privacy={privacy} />
    </SettingCard>
  );
}

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
      subtitle="Take a copy of everything you have put into Notomi."
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

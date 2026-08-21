import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { query, where } from 'firebase/firestore';
import { Icon, type IconTone } from '@/components/Icon';
import { Card, Notice } from '@/components/ui';
import { Sheet } from '@/components/Sheet';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type {
  AttendanceLog,
  AttendanceStatus,
  ClassBlock,
  Semester,
  Subject,
  Todo,
} from '@/lib/schema';
import { attendanceSummary, buildBurnoutWeeks, saveAttendanceStatus } from '@/services/academicPlanner';
import { getDb } from '@/services/firebase';
import { workloadTint } from '@/lib/color';
import { useAttendanceThreshold } from '@/lib/academicRules';

export function BurnoutHeatmap({ semester, todos }: { semester: Semester | null; todos: Todo[] }) {
  const weeks = useMemo(() => buildBurnoutWeeks(semester, todos), [semester, todos]);
  if (!semester?.startDate || weeks.length === 0) return null;
  const peak = Math.max(1, ...weeks.map((week) => week.workload));

  return (
    <Card className="mb-6 gap-4">
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1 gap-1">
          <Text className="text-[15px] font-semibold text-ink">Semester burnout heatmap</Text>
          <Text className="text-xs leading-5 text-muted">
            {semester.name} workload by week, weighted by deadline type and priority.
          </Text>
        </View>
        <Icon name="activity" size={18} tone="accent" />
      </View>

      <View className="flex-row flex-wrap gap-2">
        {weeks.map((week) => {
          return (
            <View key={week.index} className="items-center gap-1">
              <View
                accessibilityLabel={`Week ${week.index + 1}: ${week.tasks} deadlines, workload ${week.workload}`}
                className="h-8 w-8 items-center justify-center rounded-md border border-ink/5"
                style={{ backgroundColor: workloadTint(week.workload, peak) }}
              >
                <Text className="text-[10px] font-semibold text-ink/70">{week.index + 1}</Text>
              </View>
              <Text className="text-[9px] text-subtle">{week.tasks}</Text>
            </View>
          );
        })}
      </View>

      <Text className="text-[11px] leading-4 text-subtle">
        The number under each week is its open deadline count. Darker warm weeks carry more weighted
        work.
      </Text>
    </Card>
  );
}

/*
 * Written out rather than interpolated. Tailwind reads the source as text, so
 * a class built from a variable — `bg-${tone}-soft` — is a class it never
 * generates, and the chip silently loses its background.
 */
const GUARD_TONE = {
  pine: { chip: 'bg-pine-soft', text: 'text-pine', bar: 'bg-pine' },
  amber: { chip: 'bg-amber-soft', text: 'text-amber', bar: 'bg-amber' },
  rose: { chip: 'bg-rose-soft', text: 'text-rose', bar: 'bg-rose' },
} as const;

export function AttendanceGuard({
  uid,
  subject,
  classes,
  semester,
}: {
  uid: string;
  subject: Subject;
  classes: ClassBlock[];
  semester: Semester | null;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const subjectClasses = useMemo(
    () => classes.filter((block) => block.subjectId === subject.id),
    [classes, subject.id]
  );
  const logs = useCollection<AttendanceLog>(
    query(paths.attendanceLogs(getDb(), uid), where('subjectId', '==', subject.id)),
    [uid, subject.id]
  );
  const dates = useMemo(
    () => scheduledAttendanceDates(subjectClasses, semester),
    [subjectClasses, semester]
  );
  const byKey = useMemo(
    () => new Map(logs.data.map((log) => [`${log.classId}|${log.date}`, log])),
    [logs.data]
  );
  const recordedSubject =
    logs.data.length > 0
      ? {
          ...subject,
          attendanceAttended: logs.data.filter((log) => log.status === 'present').length,
          attendanceMissed: logs.data.filter((log) => log.status === 'absent').length,
        }
      : subject;
  // Subscribed to rather than only read inside attendanceSummary, so changing
  // the rule in Settings reaches a subject page that is already open.
  const [threshold] = useAttendanceThreshold();
  const summary = attendanceSummary(recordedSubject, subjectClasses.length, semester);
  const excused = logs.data.filter((log) => log.status === 'excused').length;

  async function record(entry: AttendanceDate, status: AttendanceStatus) {
    const key = `${entry.classId}|${entry.date}`;
    setSaving(key);
    setError(null);
    try {
      await saveAttendanceStatus(uid, {
        subjectId: subject.id,
        classId: entry.classId,
        date: entry.date,
        status,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(null);
    }
  }

  /*
   * Two lines, not one row of six things.
   *
   * This was a fixed 48-point row carrying an icon, a title, a counter, a
   * number, its label, a chevron, a divider and a button. At 390 points the
   * title alone wrapped to two lines and pushed the rest through the bottom
   * of the box. Nothing was wrong with the information — there was just never
   * a width at which it fit on one line.
   *
   * So the headline is the answer the student came for, the working is the
   * quiet line under it, and the bar makes the margin visible without a
   * second number to read.
   */
  const rate = summary.percentage;
  const safe = summary.safeSkips;
  const level: keyof typeof GUARD_TONE = safe === 0 ? 'rose' : safe <= 1 ? 'amber' : 'pine';
  const paint = GUARD_TONE[level];
  const headline =
    summary.held === 0
      ? 'Nothing logged yet'
      : safe === 0
        ? 'No absences left'
        : `${safe} safe skip${safe === 1 ? '' : 's'} left`;

  return (
    <View className="mb-6 gap-2">
      <View className="rounded-xl border border-line bg-surface">
        <View className="flex-row items-center gap-2 px-3 py-2.5">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`Attendance Guard. ${headline}. Show attendance dates.`}
            onPress={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 flex-row items-center gap-2.5"
          >
            <View className={`h-8 w-8 shrink-0 items-center justify-center rounded-lg ${paint.chip}`}>
              <Icon name="shield" size={15} tone={level} />
            </View>
            <View className="min-w-0 flex-1">
              <Text className={`text-sm font-semibold ${paint.text}`} numberOfLines={1}>
                {headline}
              </Text>
              <Text className="text-[11px] text-muted" numberOfLines={1}>
                {summary.held} logged
                {rate === null ? '' : ` · ${rate.toFixed(0)}% attended`} · {threshold}% needed
              </Text>
            </View>
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15} tone="subtle" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit attendance history"
            onPress={() => setHistoryOpen(true)}
            className="h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line"
          >
            <Icon name="edit-3" size={15} tone="muted" />
          </Pressable>
        </View>

        {/* The rule as a line rather than a percentage to compare against one. */}
        {rate === null ? null : (
          <View className="px-3 pb-2.5">
            <View className="h-1.5 overflow-hidden rounded-full bg-line">
              <View
                className={`h-full rounded-full ${paint.bar}`}
                style={{ width: `${Math.max(2, Math.min(100, rate))}%` }}
              />
            </View>
          </View>
        )}
      </View>

      {expanded ? (
        subjectClasses.length === 0 ? (
          <Notice
            tone="amber"
            title="No timetable sessions linked"
            body="Import or add a class for this subject before logging attendance."
          />
        ) : dates.length === 0 ? (
          <Notice
            tone="amber"
            title="Academic dates are not anchored"
            body="Upload an academic calendar or add term start and end dates before logging attendance by date."
          />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 py-1">
            {dates.slice(0, 80).map((entry) => {
              const log = byKey.get(`${entry.classId}|${entry.date}`);
              const next = nextAttendanceStatus(log?.status);
              return (
                <Pressable
                  key={`${entry.classId}-${entry.date}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.label}, ${log?.status ?? 'not logged'}. Set ${next}.`}
                  disabled={saving !== null}
                  onPress={() => void record(entry, next)}
                  className={`min-w-[76px] items-center gap-0.5 rounded-xl border px-3 py-2 ${attendanceTone(log?.status)}`}
                >
                  <Text className="text-[11px] font-semibold text-ink">{entry.label}</Text>
                  <Text className="text-[10px] capitalize text-muted">{log?.status ?? 'Log'}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )
      ) : null}

      {error ? <Notice title="Attendance was not saved" body={error} /> : null}

      <Sheet
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Attendance History"
        icon="edit-3"
        maxHeight={680}
      >
        <View className="flex-row flex-wrap gap-3 rounded-xl bg-paper px-3 py-2">
          <Metric label="Present" value={String(summary.attended)} />
          <Metric label="Absent" value={String(summary.missed)} />
          <Metric label="Excused" value={String(excused)} />
          <Metric label="Rate" value={summary.percentage === null ? '—' : `${summary.percentage.toFixed(0)}%`} />
        </View>
        <View className="gap-2">
          {[...dates].reverse().map((entry) => {
            const log = byKey.get(`${entry.classId}|${entry.date}`);
            return (
              <View key={`${entry.classId}-${entry.date}`} className="flex-row items-center gap-3 rounded-xl border border-line p-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-ink">{entry.longLabel}</Text>
                  <Text className="text-xs text-muted">{entry.time}</Text>
                </View>
                {(['present', 'absent', 'excused'] as AttendanceStatus[]).map((status) => (
                  <Pressable
                    key={status}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: log?.status === status }}
                    accessibilityLabel={`Mark ${entry.longLabel} ${status}`}
                    disabled={saving !== null}
                    onPress={() => void record(entry, status)}
                    className={`h-9 w-9 items-center justify-center rounded-lg border ${
                      log?.status === status ? attendanceTone(status) : 'border-line bg-surface'
                    }`}
                  >
                    <Icon name={attendanceIcon(status)} size={15} tone={attendanceIconTone(status)} />
                  </Pressable>
                ))}
              </View>
            );
          })}
        </View>
      </Sheet>
    </View>
  );
}

type AttendanceDate = {
  classId: string;
  date: string;
  label: string;
  longLabel: string;
  time: string;
};

function scheduledAttendanceDates(classes: ClassBlock[], semester: Semester | null): AttendanceDate[] {
  const start = semester?.startDate?.toDate?.();
  const end = semester?.teachingEndDate?.toDate?.() ?? semester?.endDate?.toDate?.();
  if (!start || !end) return [];
  const rows: AttendanceDate[] = [];
  for (const block of classes) {
    const cursor = new Date(start);
    while (((cursor.getDay() + 6) % 7) !== block.day) cursor.setDate(cursor.getDate() + 1);
    while (cursor <= end && rows.length < 400) {
      const date = localDateKey(cursor);
      rows.push({
        classId: block.id,
        date,
        label: cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        longLabel: cursor.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
        time: `${block.kind || 'Class'} · ${Math.floor(block.startMinute / 60).toString().padStart(2, '0')}:${String(block.startMinute % 60).padStart(2, '0')}`,
      });
      cursor.setDate(cursor.getDate() + 7);
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nextAttendanceStatus(status?: AttendanceStatus): AttendanceStatus {
  return status === 'present' ? 'absent' : status === 'absent' ? 'excused' : 'present';
}

function attendanceTone(status?: AttendanceStatus): string {
  if (status === 'present') return 'border-pine/40 bg-pine-soft';
  if (status === 'absent') return 'border-rose/40 bg-rose-soft';
  if (status === 'excused') return 'border-amber/40 bg-amber-soft';
  return 'border-line bg-surface';
}

function attendanceIcon(status: AttendanceStatus): 'check-circle-2' | 'x-circle' | 'shield' {
  return status === 'present' ? 'check-circle-2' : status === 'absent' ? 'x-circle' : 'shield';
}

function attendanceIconTone(status: AttendanceStatus): IconTone {
  return status === 'present' ? 'pine' : status === 'absent' ? 'rose' : 'amber';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[92px] flex-1 rounded-xl bg-paper px-3 py-2.5">
      <Text className="text-base font-bold text-ink">{value}</Text>
      <Text className="text-[11px] text-muted">{label}</Text>
    </View>
  );
}

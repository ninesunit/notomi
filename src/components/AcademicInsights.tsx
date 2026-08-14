import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { query, where } from 'firebase/firestore';
import { Icon } from '@/components/Icon';
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
        <Icon name="activity" size={18} color="#B4552D" />
      </View>

      <View className="flex-row flex-wrap gap-2">
        {weeks.map((week) => {
          const ratio = week.workload / peak;
          const color =
            week.workload === 0
              ? '#E9E5D9'
              : ratio <= 0.33
                ? '#DCE9E3'
                : ratio <= 0.66
                  ? '#EAD9B6'
                  : '#E7BDB8';
          return (
            <View key={week.index} className="items-center gap-1">
              <View
                accessibilityLabel={`Week ${week.index + 1}: ${week.tasks} deadlines, workload ${week.workload}`}
                className="h-8 w-8 items-center justify-center rounded-md border border-ink/5"
                style={{ backgroundColor: color }}
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

  return (
    <View className="mb-6 gap-2">
      <View className="h-12 flex-row items-center rounded-xl border border-line bg-surface px-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel="Show attendance dates"
          onPress={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 flex-row items-center gap-2.5"
        >
          <Icon name="shield" size={15} color="#2E6F5E" />
          <Text className="text-sm font-semibold text-ink">Attendance Guard</Text>
          <Text className="text-xs text-muted">{summary.held} logged</Text>
          <View className="ml-auto flex-row items-baseline gap-1">
            <Text className="text-base font-bold text-pine">{summary.safeSkips}</Text>
            <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted">safe skips</Text>
          </View>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="#9A9488" />
        </Pressable>
        <View className="mx-2 h-6 w-px bg-line" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit attendance history"
          onPress={() => setHistoryOpen(true)}
          className="h-9 w-9 items-center justify-center rounded-lg"
        >
          <Icon name="edit-3" size={15} color="#6F6A5F" />
        </Pressable>
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
                    <Icon name={attendanceIcon(status)} size={15} color={attendanceColor(status)} />
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

function attendanceColor(status: AttendanceStatus): string {
  return status === 'present' ? '#2E6F5E' : status === 'absent' ? '#B0443E' : '#B4832A';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[92px] flex-1 rounded-xl bg-paper px-3 py-2.5">
      <Text className="text-base font-bold text-ink">{value}</Text>
      <Text className="text-[11px] text-muted">{label}</Text>
    </View>
  );
}

import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Button, Card, Notice } from '@/components/ui';
import type { ClassBlock, Semester, Subject, Todo } from '@/lib/schema';
import { attendanceSummary, buildBurnoutWeeks, recordAttendance } from '@/services/academicPlanner';

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
        <Feather name="activity" size={18} color="#B4552D" />
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const weeklySessions = classes.filter((block) => block.subjectId === subject.id).length;
  const summary = attendanceSummary(subject, weeklySessions, semester);

  async function record(outcome: 'attended' | 'missed') {
    setSaving(true);
    setError(null);
    try {
      await recordAttendance(uid, subject.id, outcome);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6 gap-4">
      <View className="flex-row flex-wrap items-start justify-between gap-4">
        <View className="flex-1 gap-1" style={{ minWidth: 220 }}>
          <View className="flex-row items-center gap-2">
            <Feather name="shield" size={16} color="#2E6F5E" />
            <Text className="text-[15px] font-semibold text-ink">Attendance Guard</Text>
          </View>
          <Text className="text-xs leading-5 text-muted">
            Based on an 80% requirement and {weeklySessions} scheduled session
            {weeklySessions === 1 ? '' : 's'} per week.
          </Text>
        </View>
        <View className="items-end gap-0.5">
          <Text className="text-2xl font-bold text-pine">{summary.safeSkips}</Text>
          <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Safe skips left
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-3">
        <Metric label="Recorded" value={String(summary.held)} />
        <Metric label="Attended" value={String(summary.attended)} />
        <Metric label="Missed" value={String(summary.missed)} />
        <Metric
          label="Current rate"
          value={summary.percentage === null ? 'No record' : `${summary.percentage.toFixed(0)}%`}
        />
      </View>

      {weeklySessions === 0 ? (
        <Notice
          tone="amber"
          title="No timetable sessions linked"
          body="Import or add classes for this subject before relying on the safe-skip allowance."
        />
      ) : null}

      {error ? <Notice title="Attendance was not saved" body={error} /> : null}

      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Record attended"
          icon="check"
          size="sm"
          loading={saving}
          onPress={() => void record('attended')}
        />
        <Button
          label="Record missed"
          icon="x"
          size="sm"
          variant="secondary"
          disabled={saving}
          onPress={() => void record('missed')}
        />
      </View>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[92px] flex-1 rounded-xl bg-paper px-3 py-2.5">
      <Text className="text-base font-bold text-ink">{value}</Text>
      <Text className="text-[11px] text-muted">{label}</Text>
    </View>
  );
}

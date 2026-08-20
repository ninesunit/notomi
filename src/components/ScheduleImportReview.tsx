import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { orderBy, query } from 'firebase/firestore';
import { Icon } from './Icon';
import { ResponsiveTermPicker } from './ResponsiveTermPicker';
import { ScreenScroll } from './ScreenScroll';
import { SurfaceBack } from './SurfaceBack';
import { Button, Card, EmptyState, Field, Notice, PageHeader } from './ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useIngest } from '@/hooks/useIngest';
import { paths } from '@/lib/paths';
import { DAY_FULL, DAY_LABELS, parseClock, type Semester } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { commitImport, type ImportRow } from '@/services/timetable';

export function ScheduleImportReview() {
  const uid = useUid();
  const router = useRouter();
  const ingest = useIngest();
  const semesters = useCollection<Semester>(
    query(paths.semesters(getDb(), uid), orderBy('order', 'asc')),
    [uid]
  );
  const [rows, setRows] = useState<ImportRow[]>(() => ingest.scheduleReview?.rows ?? []);
  const [semesterId, setSemesterId] = useState<string | null>(
    () => semesters.data.find((entry) => entry.isCurrent)?.id ?? null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const termInitialized = useRef(false);

  useEffect(() => {
    if (semesters.loading || termInitialized.current) return;
    termInitialized.current = true;
    const current = semesters.data.find((entry) => entry.isCurrent);
    if (current) setSemesterId(current.id);
  }, [semesters.loading, semesters.data]);

  const included = useMemo(
    () =>
      rows.filter((row) => {
        const start = parseClock(row.start);
        const end = parseClock(row.end);
        return row.include && row.title.trim() && start !== null && end !== null && end > start;
      }),
    [rows]
  );

  const patch = (id: string, change: Partial<ImportRow>) =>
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              ...change,
              ...('code' in change || 'title' in change ? { existingSubjectId: null } : {}),
            }
          : row
      )
    );

  function addClass() {
    setRows((current) => [
      ...current,
      {
        id: `manual-${Date.now()}`,
        include: true,
        title: '',
        code: '',
        section: '',
        kind: 'Lecture',
        day: 0,
        start: '09:00',
        end: '10:00',
        venue: '',
        existingSubjectId: null,
        sourceFile: 'Manual review entry',
        conflicts: [],
      },
    ]);
  }

  async function confirm() {
    if (included.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await commitImport(uid, rows, { semesterId });
      ingest.clearScheduleReview();
      router.replace('/schedule?tab=timetable' as never);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  if (!ingest.scheduleReview && rows.length === 0) {
    return (
      <ScreenScroll>
        <SurfaceBack href="/schedule" label="Back to Schedule" />
        <View className="mt-4">
          <EmptyState
            icon="calendar"
            title="No schedule is waiting for review"
            body="Upload a schedule from the Dashboard or Schedule page. Notomi will bring the extracted classes here before saving anything."
          />
        </View>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll maxWidth={920}>
      <SurfaceBack href="/schedule" label="Back to Schedule" />
      <View className="mt-4">
        <PageHeader
          title="AI Import Summary"
          subtitle="Review & approve your schedule below. Nothing is saved until you confirm."
          actions={<Button label="Add Class" icon="plus" variant="secondary" size="sm" onPress={addClass} />}
        />
      </View>

      <Notice
        tone="pine"
        title="AI Import Summary — Review & approve your schedule below."
        body={`${rows.length} class session${rows.length === 1 ? '' : 's'} detected from ${
          ingest.scheduleReview?.sourceFiles.length ?? 1
        } file${(ingest.scheduleReview?.sourceFiles.length ?? 1) === 1 ? '' : 's'}.`}
      />

      {ingest.scheduleReview?.skipped ? (
        <View className="mt-3">
          <Notice
            tone="amber"
            title={`${ingest.scheduleReview.skipped} unreadable row${ingest.scheduleReview.skipped === 1 ? '' : 's'} left out`}
            body="Use Add Class to enter anything the source image did not show clearly."
          />
        </View>
      ) : null}

      <Card className="my-5 gap-3">
        <Text className="text-sm font-semibold text-ink">Save to term</Text>
        <ResponsiveTermPicker
          options={[
            ...semesters.data.map((semester) => ({
              id: semester.id,
              label: semester.name,
              current: semester.isCurrent,
            })),
            { id: 'unassigned', label: 'Unassigned' },
          ]}
          value={semesterId ?? 'unassigned'}
          onChange={(next) => setSemesterId(next === 'unassigned' ? null : next)}
          title="Save schedule to term"
        />
      </Card>

      <View className="gap-3">
        {rows.map((row, index) => (
          <ReviewClassCard
            key={row.id}
            row={row}
            index={index}
            onPatch={(change) => patch(row.id, change)}
            onRemove={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
          />
        ))}
      </View>

      <Button
        label="Add Class"
        icon="plus"
        variant="secondary"
        className="mt-4 self-start"
        onPress={addClass}
      />

      {error ? <View className="mt-4"><Notice title="Schedule was not saved" body={error} /></View> : null}

      <Card className="mt-5 flex-row flex-wrap items-center gap-3 border-line">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-ink">Ready to save</Text>
          <Text className="text-xs text-muted">{included.length} valid class session{included.length === 1 ? '' : 's'} will be committed.</Text>
        </View>
        <Button
          label="Confirm & Save to Term"
          icon="check-circle-2"
          loading={saving}
          disabled={saving || included.length === 0}
          onPress={() => void confirm()}
        />
      </Card>
    </ScreenScroll>
  );
}

function ReviewClassCard({
  row,
  index,
  onPatch,
  onRemove,
}: {
  row: ImportRow;
  index: number;
  onPatch: (change: Partial<ImportRow>) => void;
  onRemove: () => void;
}) {
  const start = parseClock(row.start);
  const end = parseClock(row.end);
  const invalid = start === null || end === null || end <= start || !row.title.trim();

  return (
    <Card className={`gap-4 border-line ${row.include ? '' : 'opacity-60'}`}>
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: row.include }}
          onPress={() => onPatch({ include: !row.include })}
          className={`h-6 w-6 items-center justify-center rounded-lg border ${row.include ? 'border-ink bg-ink' : 'border-line'}`}
        >
          {row.include ? <Icon name="check" size={13} tone="inverse" /> : null}
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-bold text-ink">Class {index + 1}</Text>
          <Text className="text-xs text-muted" numberOfLines={1}>
            {row.title || 'Untitled course'}{row.code ? ` • ${row.code}` : ''} · {DAY_FULL[row.day]}
          </Text>
        </View>
        <Button label="Remove" icon="trash-2" variant="danger" size="sm" onPress={onRemove} />
      </View>

      <View className="flex-row flex-wrap gap-3">
        <View className="min-w-[220px] flex-[2]">
          <Field label="Course title" value={row.title} onChangeText={(title) => onPatch({ title })} placeholder="Research Methods" />
        </View>
        <View className="min-w-[150px] flex-1">
          <Field label="Course code" value={row.code} onChangeText={(code) => onPatch({ code })} placeholder="CPT6123" autoCapitalize="characters" />
        </View>
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Day of week</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {DAY_LABELS.map((label, day) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityState={{ selected: row.day === day }}
              onPress={() => onPatch({ day })}
              className={`rounded-lg px-3 py-2 ${row.day === day ? 'bg-ink' : 'bg-sand'}`}
            >
              <Text className={`text-xs font-semibold ${row.day === day ? 'text-paper' : 'text-ink'}`}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View className="flex-row flex-wrap gap-3">
        <View className="min-w-[130px] flex-1"><Field label="Starts" value={row.start} onChangeText={(start) => onPatch({ start })} placeholder="08:00" /></View>
        <View className="min-w-[130px] flex-1"><Field label="Ends" value={row.end} onChangeText={(end) => onPatch({ end })} placeholder="10:00" /></View>
        <View className="min-w-[170px] flex-1"><Field label="Class type" value={row.kind} onChangeText={(kind) => onPatch({ kind })} placeholder="Lecture" /></View>
      </View>

      <Field label="Location / room code" value={row.venue} onChangeText={(venue) => onPatch({ venue })} placeholder="CQAR2005-FCI CISCO Network Lab" />

      {row.conflicts.length > 0 ? (
        <Notice
          tone="amber"
          title={`${row.conflicts.length} schedule conflict${row.conflicts.length === 1 ? '' : 's'}`}
          body={row.conflicts.map((conflict) => conflict.title).join(', ')}
        />
      ) : invalid ? (
        <Notice tone="amber" title="Complete the title and use an end time after the start time." />
      ) : null}
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Sheet } from './Sheet';
import { Button, Field, Notice } from './ui';
import {
  DAY_LABELS,
  knownTerms,
  minutesToLabel,
  parseClock,
  TERM_SUGGESTIONS,
  type Semester,
} from '@/lib/schema';
import { createSemester } from '@/services/program';
import { commitImport, type ImportOutcome, type ImportRow } from '@/services/timetable';

/**
 * Review before import.
 *
 * Vision reads a schedule well but not perfectly, and this import writes into
 * three places at once — the library, the timetable and the program structure.
 * Writing all that from an unreviewed guess would leave a student cleaning up
 * folders they never asked for, so nothing is committed until they have seen
 * every row and chosen the term it belongs to.
 */
export function ImportReview({
  uid,
  rows: initialRows,
  skipped,
  semesters,
  onClose,
  onDone,
}: {
  uid: string;
  rows: ImportRow[];
  skipped: number;
  semesters: Semester[];
  onClose: () => void;
  onDone: (outcome: ImportOutcome) => void;
}) {
  const [rows, setRows] = useState(initialRows);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [semesterId, setSemesterId] = useState<string | null>(
    semesters.find((semester) => semester.isCurrent)?.id ?? null
  );
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const termOptions = useMemo(() => {
    const used = knownTerms(semesters);
    const seen = new Set(used.map((value) => value.toLowerCase()));
    return [...used, ...TERM_SUGGESTIONS.filter((value) => !seen.has(value.toLowerCase()))];
  }, [semesters]);

  const included = rows.filter((row) => row.include);
  const courses = new Set(
    included.map((row) => (row.code.trim() || row.title.trim()).toLowerCase())
  ).size;
  const reused = included.filter((row) => row.existingSubjectId).length;

  const patch = (id: string, change: Partial<ImportRow>) =>
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...change } : row)));

  async function confirm() {
    if (included.length === 0) return;
    setSaving(true);
    setError(null);

    try {
      // A typed term that is not an existing one becomes a new term, so the
      // student never has to visit the planner first.
      let targetSemester = semesterId;
      if (!targetSemester && term.trim()) {
        targetSemester = await createSemester(
          uid,
          {
            name: term.trim(),
            year: new Date().getFullYear(),
            term: term.trim(),
            gpaTarget: null,
          },
          semesters
        );
      }

      const outcome = await commitImport(uid, rows, { semesterId: targetSemester });
      onDone(outcome);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <Sheet
      visible
      onClose={onClose}
      title="Review your schedule"
      icon="check-square"
      maxHeight={520}
      // These rows cost a Gemini call to produce. A tap on the scrim used to
      // throw the whole scan away, which read as the review "disappearing".
      dismissOnScrim={false}
      footer={
        <>
          <Text className="flex-1 text-xs text-muted">
            {discarding
              ? 'Discard this scan?'
              : `${included.length} of ${rows.length} classes · ${courses} ${
                  courses === 1 ? 'subject' : 'subjects'
                }`}
          </Text>
          {/* Discarding means paying for another scan, so it asks once. */}
          <Button
            label={discarding ? 'Yes, discard' : 'Cancel'}
            variant={discarding ? 'danger' : 'ghost'}
            size="sm"
            disabled={saving}
            onPress={() => (discarding ? onClose() : setDiscarding(true))}
          />
          <Button
            label={discarding ? 'Keep' : saving ? 'Importing…' : 'Import'}
            icon={discarding ? undefined : 'download'}
            size="sm"
            loading={saving}
            disabled={saving || (!discarding && included.length === 0)}
            onPress={() => (discarding ? setDiscarding(false) : void confirm())}
          />
        </>
      }
    >
      <Text className="text-xs leading-5 text-subtle">
        Check what Gemini read before it is saved. Importing creates a library folder per subject,
        fills your weekly timetable, and files everything under the term you choose.
      </Text>

      {skipped > 0 ? (
        <Notice
          tone="amber"
          title={`${skipped} row${skipped === 1 ? '' : 's'} could not be read`}
          body="Their day or time was unreadable, so they were left out rather than guessed at. Add them by hand after importing."
        />
      ) : null}

      {/* Term first: it applies to every row, so choosing it after editing
          twelve classes would be the wrong order. */}
      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Which term is this?</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {semesters.map((semester) => (
            <Pressable
              key={semester.id}
              accessibilityRole="button"
              accessibilityState={{ selected: semesterId === semester.id }}
              onPress={() => {
                setSemesterId(semester.id);
                setTerm('');
              }}
              className={`rounded-lg px-3 py-2 ${semesterId === semester.id ? 'bg-ink' : 'bg-sand'}`}
            >
              <Text
                className={`text-xs font-semibold ${
                  semesterId === semester.id ? 'text-paper' : 'text-ink'
                }`}
              >
                {semester.name}
              </Text>
            </Pressable>
          ))}
        </View>

        <Field
          value={term}
          onChangeText={(value) => {
            setTerm(value);
            if (value.trim()) setSemesterId(null);
          }}
          placeholder="…or type a new term, e.g. Trimester 1 - 2026"
        />

        {!semesterId ? (
          <View className="flex-row flex-wrap gap-1.5">
            {termOptions.slice(0, 6).map((option) => (
              <Pressable
                key={option}
                accessibilityRole="button"
                onPress={() => setTerm(option)}
                className="rounded-lg bg-sand px-2.5 py-1"
              >
                <Text className="text-[11px] font-semibold text-muted">{option}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-medium text-muted">Detected classes</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              setRows((previous) =>
                previous.map((row) => ({ ...row, include: included.length !== previous.length }))
              )
            }
            hitSlop={6}
          >
            <Text className="text-xs font-semibold text-accent">
              {included.length === rows.length ? 'Deselect all' : 'Select all'}
            </Text>
          </Pressable>
        </View>

        {rows.map((row) => {
          const open = expanded === row.id;
          const startMinute = parseClock(row.start);
          const endMinute = parseClock(row.end);
          const timesValid =
            startMinute !== null && endMinute !== null && endMinute > startMinute;

          return (
            <View
              key={row.id}
              className={`gap-2 rounded-xl border p-3 ${
                row.include ? 'border-line bg-surface' : 'border-line bg-paper opacity-60'
              }`}
            >
              <View className="flex-row items-center gap-3">
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: row.include }}
                  accessibilityLabel={`Include ${row.title}`}
                  onPress={() => patch(row.id, { include: !row.include })}
                  className={`h-5 w-5 items-center justify-center rounded-md border ${
                    row.include ? 'border-pine bg-pine' : 'border-subtle bg-surface'
                  }`}
                >
                  {row.include ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
                </Pressable>

                <Pressable className="flex-1" onPress={() => setExpanded(open ? null : row.id)}>
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                    {[row.code, row.title].filter(Boolean).join(' · ')}
                  </Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {DAY_LABELS[row.day]}{' '}
                    {timesValid && startMinute !== null && endMinute !== null
                      ? `${minutesToLabel(startMinute)}–${minutesToLabel(endMinute)}`
                      : `${row.start}–${row.end}`}
                    {row.venue ? ` · ${row.venue}` : ''}
                    {row.existingSubjectId ? ' · existing subject' : ''}
                  </Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${row.title}`}
                  onPress={() => setExpanded(open ? null : row.id)}
                  hitSlop={8}
                >
                  <Feather name={open ? 'chevron-up' : 'edit-2'} size={14} color="#6F6A5F" />
                </Pressable>
              </View>

              {open ? (
                <View className="gap-3 border-t border-line pt-3">
                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <Field
                        label="Code"
                        value={row.code}
                        onChangeText={(value) => patch(row.id, { code: value })}
                        placeholder="CS2040"
                        autoCapitalize="characters"
                      />
                    </View>
                    <View className="flex-[2]">
                      <Field
                        label="Subject"
                        value={row.title}
                        onChangeText={(value) => patch(row.id, { title: value })}
                        placeholder="Data Structures"
                      />
                    </View>
                  </View>

                  <View className="gap-1.5">
                    <Text className="text-sm font-medium text-muted">Day</Text>
                    <View className="flex-row flex-wrap gap-1">
                      {DAY_LABELS.map((label, index) => (
                        <Pressable
                          key={label}
                          accessibilityRole="button"
                          accessibilityState={{ selected: row.day === index }}
                          onPress={() => patch(row.id, { day: index })}
                          className={`rounded-lg px-2.5 py-1.5 ${
                            row.day === index ? 'bg-ink' : 'bg-sand'
                          }`}
                        >
                          <Text
                            className={`text-[11px] font-semibold ${
                              row.day === index ? 'text-paper' : 'text-ink'
                            }`}
                          >
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>

                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <Field
                        label="Starts"
                        value={row.start}
                        onChangeText={(value) => patch(row.id, { start: value })}
                        placeholder="09:00"
                        autoCapitalize="none"
                      />
                    </View>
                    <View className="flex-1">
                      <Field
                        label="Ends"
                        value={row.end}
                        onChangeText={(value) => patch(row.id, { end: value })}
                        placeholder="11:00"
                        autoCapitalize="none"
                        hint={!timesValid ? 'e.g. 9:00 AM or 09:00, ending after it starts.' : undefined}
                      />
                    </View>
                  </View>

                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <Field
                        label="Type"
                        value={row.kind}
                        onChangeText={(value) => patch(row.id, { kind: value })}
                        placeholder="Lecture"
                      />
                    </View>
                    <View className="flex-1">
                      <Field
                        label="Room"
                        value={row.venue}
                        onChangeText={(value) => patch(row.id, { venue: value })}
                        placeholder="LT-15"
                      />
                    </View>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      {reused > 0 ? (
        <Text className="text-xs text-subtle">
          {reused} class{reused === 1 ? '' : 'es'} matched a subject you already have — those folders
          will be reused, not duplicated.
        </Text>
      ) : null}

      {error ? <Notice title="Could not import" body={error} /> : null}
    </Sheet>
  );
}

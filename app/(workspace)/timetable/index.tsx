import { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, EmptyState, Field, IconButton, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import {
  colorForSubject,
  DAY_FULL,
  DAY_LABELS,
  minutesToClock,
  minutesToLabel,
  parseClock,
  todayIndex,
  type ClassBlock,
  type Subject,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { pickMaterials, type MaterialFile } from '@/services/ingestion';
import {
  classesForDay,
  clearTimetable,
  deleteClass,
  saveClass,
  saveClassBlocks,
  scanTimetableImage,
  type ClassInput,
} from '@/services/timetable';

/**
 * The weekly timetable.
 *
 * On a wide screen this is a real grid — seven day columns against an hour
 * ruler, because that is the shape a student already has in their head. Below
 * that it collapses to a day-by-day agenda, since seven columns on a phone are
 * seven unreadable slivers.
 */

const GRID_BREAKPOINT = 900;
/** Pixels per hour in the grid. Enough for a title and a room at 45 minutes. */
const HOUR_HEIGHT = 56;

export default function Timetable() {
  const uid = useUid();
  const db = getDb();
  const { width } = useWindowDimensions();

  const [editing, setEditing] = useState<ClassBlock | 'new' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selectedDay, setSelectedDay] = useState(todayIndex());

  const classes = useCollection<ClassBlock>(
    query(paths.classes(db, uid), orderBy('startMinute', 'asc')),
    [uid]
  );
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);

  const grid = width >= GRID_BREAKPOINT;

  /**
   * The visible hour range is derived from the actual schedule, padded by an
   * hour. A fixed 00:00-24:00 ruler would make a normal week a thin band in an
   * ocean of empty night.
   */
  const [firstHour, lastHour] = useMemo(() => {
    if (classes.data.length === 0) return [8, 18];
    const start = Math.min(...classes.data.map((block) => block.startMinute));
    const end = Math.max(...classes.data.map((block) => block.endMinute));
    return [Math.max(0, Math.floor(start / 60) - 1), Math.min(24, Math.ceil(end / 60) + 1)];
  }, [classes.data]);

  const scan = useCallback(async () => {
    setError(null);
    setNotice(null);

    let picked: MaterialFile[] = [];
    try {
      picked = await pickMaterials();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (picked.length === 0) return;

    setScanning(true);
    try {
      const file = picked[0];
      const bytes = file.file ? await file.file.arrayBuffer() : await (await fetch(file.uri)).arrayBuffer();
      const result = await scanTimetableImage(
        bytes,
        file.name,
        file.mimeType ?? '',
        subjects.data
      );

      await saveClassBlocks(uid, result.blocks);
      setNotice(
        `Added ${result.imported} class${result.imported === 1 ? '' : 'es'} from your screenshot.` +
          (result.skipped > 0
            ? ` ${result.skipped} row${result.skipped === 1 ? '' : 's'} could not be read and ${
                result.skipped === 1 ? 'was' : 'were'
              } skipped — add ${result.skipped === 1 ? 'it' : 'them'} by hand.`
            : ' Check the times before you rely on them.')
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScanning(false);
    }
  }, [subjects.data, uid]);

  const remove = useCallback(
    async (classId: string) => {
      setError(null);
      try {
        await deleteClass(uid, classId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [uid]
  );

  const loading = classes.loading || subjects.loading;

  return (
    <ScreenScroll>
      <PageHeader
        title="Timetable"
        subtitle={
          classes.data.length
            ? `${classes.data.length} class${classes.data.length === 1 ? '' : 'es'} a week`
            : 'Upload a screenshot of your schedule and Gemini will read it into a grid.'
        }
        actions={
          <>
            <Button
              label={scanning ? 'Reading…' : 'Scan screenshot'}
              icon="camera"
              size="sm"
              loading={scanning}
              disabled={scanning}
              onPress={() => void scan()}
            />
            <Button
              label="Add class"
              icon="plus"
              variant="secondary"
              size="sm"
              onPress={() => setEditing('new')}
            />
          </>
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not read that timetable" body={error} />
        </View>
      ) : null}

      {notice ? (
        <View className="mb-6">
          <Notice tone="pine" title="Timetable updated" body={notice} />
        </View>
      ) : null}

      {loading ? (
        <Loading label="Loading your week…" />
      ) : classes.data.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="No classes yet"
          body="Take a screenshot of your university schedule and upload it — Gemini reads the grid and fills this in. You can also add classes by hand."
          action={
            <Button
              label="Scan a screenshot"
              icon="camera"
              loading={scanning}
              onPress={() => void scan()}
            />
          }
        />
      ) : grid ? (
        <WeekGrid
          classes={classes.data}
          firstHour={firstHour}
          lastHour={lastHour}
          onSelect={(block) => setEditing(block)}
        />
      ) : (
        <DayAgenda
          classes={classes.data}
          day={selectedDay}
          onDay={setSelectedDay}
          onSelect={(block) => setEditing(block)}
          onDelete={(id) => void remove(id)}
        />
      )}

      {classes.data.length > 0 ? (
        <View className="mt-10 gap-3 border-t border-line pt-6">
          {confirmClear ? (
            <>
              <Notice
                tone="rose"
                title="Clear the whole timetable?"
                body={`This removes all ${classes.data.length} classes. Your subjects and material are untouched.`}
              />
              <View className="flex-row gap-2">
                <Button
                  label="Yes, clear it"
                  variant="danger"
                  size="sm"
                  icon="trash-2"
                  onPress={() => {
                    setConfirmClear(false);
                    void clearTimetable(uid).catch((caught) => setError(String(caught)));
                  }}
                />
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onPress={() => setConfirmClear(false)}
                />
              </View>
            </>
          ) : (
            <View className="items-start">
              <Button
                label="Clear timetable"
                variant="danger"
                size="sm"
                icon="trash-2"
                onPress={() => setConfirmClear(true)}
              />
              <Text className="mt-2 text-xs text-subtle">
                Useful at the start of a new semester, before scanning a fresh schedule.
              </Text>
            </View>
          )}
        </View>
      ) : null}

      <ClassModal
        uid={uid}
        block={editing}
        subjects={subjects.data}
        visible={editing !== null}
        onClose={() => setEditing(null)}
        onDelete={(id) => {
          setEditing(null);
          void remove(id);
        }}
      />
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * Wide layout: the grid
 * ------------------------------------------------------------------ */

function WeekGrid({
  classes,
  firstHour,
  lastHour,
  onSelect,
}: {
  classes: ClassBlock[];
  firstHour: number;
  lastHour: number;
  onSelect: (block: ClassBlock) => void;
}) {
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const height = hours.length * HOUR_HEIGHT;
  const today = todayIndex();

  return (
    <View className="overflow-hidden rounded-2xl border border-line bg-surface">
      <View className="flex-row border-b border-line bg-sand">
        <View className="w-14 shrink-0" />
        {DAY_LABELS.map((label, index) => (
          <View
            key={label}
            className={`flex-1 items-center py-2.5 ${index === today ? 'bg-accent-soft' : ''}`}
          >
            <Text
              className={`text-xs font-bold uppercase tracking-wider ${
                index === today ? 'text-accent' : 'text-muted'
              }`}
            >
              {label}
            </Text>
          </View>
        ))}
      </View>

      <View className="flex-row" style={{ height }}>
        {/* Hour ruler */}
        <View className="w-14 shrink-0 border-r border-line">
          {hours.map((hour) => (
            <View key={hour} style={{ height: HOUR_HEIGHT }} className="items-end pr-2 pt-1">
              <Text className="text-[10px] font-medium text-subtle">
                {minutesToLabel(hour * 60)}
              </Text>
            </View>
          ))}
        </View>

        {DAY_LABELS.map((label, day) => (
          <View
            key={label}
            className={`flex-1 border-l border-line ${day === today ? 'bg-accent-soft/25' : ''}`}
          >
            {/* Hour lines sit behind the blocks as ordinary rows. */}
            {hours.map((hour) => (
              <View key={hour} style={{ height: HOUR_HEIGHT }} className="border-b border-line/60" />
            ))}

            {classesForDay(classes, day).map((block) => {
              const top = ((block.startMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
              const blockHeight = Math.max(
                22,
                ((block.endMinute - block.startMinute) / 60) * HOUR_HEIGHT - 3
              );

              return (
                <Pressable
                  key={block.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${block.title}, ${DAY_FULL[day]} ${minutesToLabel(
                    block.startMinute
                  )} to ${minutesToLabel(block.endMinute)}`}
                  onPress={() => onSelect(block)}
                  className="absolute left-1 right-1 overflow-hidden rounded-lg px-1.5 py-1"
                  style={{
                    top: top + 1,
                    height: blockHeight,
                    backgroundColor: `${block.color}24`,
                    borderLeftWidth: 3,
                    borderLeftColor: block.color,
                  }}
                >
                  <Text className="text-[11px] font-semibold leading-tight text-ink" numberOfLines={2}>
                    {block.title}
                  </Text>
                  {blockHeight > 42 ? (
                    <Text className="text-[10px] leading-tight text-muted" numberOfLines={1}>
                      {[minutesToLabel(block.startMinute), block.venue].filter(Boolean).join(' · ')}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Narrow layout: one day at a time
 * ------------------------------------------------------------------ */

function DayAgenda({
  classes,
  day,
  onDay,
  onSelect,
  onDelete,
}: {
  classes: ClassBlock[];
  day: number;
  onDay: (day: number) => void;
  onSelect: (block: ClassBlock) => void;
  onDelete: (classId: string) => void;
}) {
  const items = classesForDay(classes, day);
  const today = todayIndex();

  return (
    <View className="gap-4">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-1.5">
          {DAY_LABELS.map((label, index) => {
            const count = classes.filter((block) => block.day === index).length;
            const active = index === day;
            return (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => onDay(index)}
                className={`min-w-[52px] items-center gap-0.5 rounded-xl px-3 py-2 ${
                  active ? 'bg-ink' : index === today ? 'bg-accent-soft' : 'bg-sand'
                }`}
              >
                <Text
                  className={`text-xs font-bold ${
                    active ? 'text-paper' : index === today ? 'text-accent' : 'text-muted'
                  }`}
                >
                  {label}
                </Text>
                <Text className={`text-[10px] ${active ? 'text-paper/70' : 'text-subtle'}`}>
                  {count || '—'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {items.length === 0 ? (
        <Card className="items-start">
          <Text className="text-sm text-muted">Nothing scheduled on {DAY_FULL[day]}.</Text>
        </Card>
      ) : (
        <View className="gap-2.5">
          {items.map((block) => (
            <View
              key={block.id}
              className="flex-row items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface p-3.5"
              style={{ borderLeftWidth: 4, borderLeftColor: block.color }}
            >
              <View className="w-[68px]">
                <Text className="text-[13px] font-bold text-ink">
                  {minutesToLabel(block.startMinute)}
                </Text>
                <Text className="text-[11px] text-subtle">{minutesToLabel(block.endMinute)}</Text>
              </View>

              <Pressable className="flex-1 gap-0.5" onPress={() => onSelect(block)}>
                <Text className="text-sm font-semibold text-ink" numberOfLines={2}>
                  {block.title}
                </Text>
                <Text className="text-xs text-muted" numberOfLines={1}>
                  {[block.kind, block.venue].filter(Boolean).join(' · ') || 'No room set'}
                </Text>
              </Pressable>

              <IconButton icon="edit-2" label={`Edit ${block.title}`} onPress={() => onSelect(block)} />
              <IconButton
                icon="trash-2"
                tone="rose"
                label={`Delete ${block.title}`}
                onPress={() => onDelete(block.id)}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Add / edit a class
 * ------------------------------------------------------------------ */

function ClassModal({
  uid,
  block,
  subjects,
  visible,
  onClose,
  onDelete,
}: {
  uid: string;
  block: ClassBlock | 'new' | null;
  subjects: Subject[];
  visible: boolean;
  onClose: () => void;
  onDelete: (classId: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-ink/40 px-5">
        {block !== null ? (
          <ClassForm
            key={block === 'new' ? 'new' : block.id}
            uid={uid}
            block={block === 'new' ? null : block}
            subjects={subjects}
            onClose={onClose}
            onDelete={onDelete}
          />
        ) : null}
      </View>
    </Modal>
  );
}

function ClassForm({
  uid,
  block,
  subjects,
  onClose,
  onDelete,
}: {
  uid: string;
  block: ClassBlock | null;
  subjects: Subject[];
  onClose: () => void;
  onDelete: (classId: string) => void;
}) {
  const [title, setTitle] = useState(block?.title ?? '');
  const [kind, setKind] = useState(block?.kind ?? '');
  const [venue, setVenue] = useState(block?.venue ?? '');
  const [day, setDay] = useState(block?.day ?? todayIndex());
  const [start, setStart] = useState(minutesToClock(block?.startMinute ?? 9 * 60));
  const [end, setEnd] = useState(minutesToClock(block?.endMinute ?? 10 * 60));
  const [subjectId, setSubjectId] = useState<string | null>(block?.subjectId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  const timesValid = startMinute !== null && endMinute !== null && endMinute > startMinute;
  const valid = title.trim().length > 0 && timesValid;

  async function save() {
    if (!valid || startMinute === null || endMinute === null) return;
    setSaving(true);
    setError(null);

    const subject = subjects.find((candidate) => candidate.id === subjectId) ?? null;
    const input: ClassInput = {
      title: title.trim(),
      kind: kind.trim() || null,
      subjectId: subject?.id ?? null,
      subjectName: subject?.name ?? null,
      day,
      startMinute,
      endMinute,
      venue: venue.trim() || null,
      color: subject?.color || block?.color || colorForSubject(title || 'class'),
    };

    try {
      await saveClass(uid, input, block?.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <View className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface">
      <View className="flex-row items-center gap-3 border-b border-line px-5 py-4">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
          <Feather name="calendar" size={16} color="#B4552D" />
        </View>
        <Text className="flex-1 text-[15px] font-semibold text-ink">
          {block ? 'Edit class' : 'Add class'}
        </Text>
        <IconButton icon="x" label="Close" onPress={onClose} />
      </View>

      <ScrollView className="max-h-[440px]" contentContainerClassName="gap-4 p-5">
        <Field label="Class" value={title} onChangeText={setTitle} placeholder="CS2040 Lecture" />

        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Day</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {DAY_LABELS.map((label, index) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityState={{ selected: day === index }}
                onPress={() => setDay(index)}
                className={`rounded-lg px-3 py-2 ${day === index ? 'bg-ink' : 'bg-sand'}`}
              >
                <Text
                  className={`text-xs font-semibold ${day === index ? 'text-paper' : 'text-ink'}`}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1">
            <Field
              label="Starts"
              value={start}
              onChangeText={setStart}
              placeholder="09:00"
              autoCapitalize="none"
            />
          </View>
          <View className="flex-1">
            <Field
              label="Ends"
              value={end}
              onChangeText={setEnd}
              placeholder="11:00"
              autoCapitalize="none"
              hint={!timesValid ? 'Use 24-hour HH:MM, ending after it starts.' : undefined}
            />
          </View>
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1">
            <Field label="Type" value={kind} onChangeText={setKind} placeholder="Lecture" />
          </View>
          <View className="flex-1">
            <Field label="Room" value={venue} onChangeText={setVenue} placeholder="LT-15" />
          </View>
        </View>

        {subjects.length > 0 ? (
          <View className="gap-2">
            <Text className="text-sm font-medium text-muted">Subject (optional)</Text>
            <Text className="text-xs text-subtle">
              Linking a class colours it to match the subject and lets the dashboard show it.
            </Text>
            <View className="flex-row flex-wrap gap-1.5">
              {subjects.map((subject) => (
                <Pressable
                  key={subject.id}
                  accessibilityRole="button"
                  onPress={() => setSubjectId(subjectId === subject.id ? null : subject.id)}
                  className={`rounded-lg border px-3 py-1.5 ${
                    subjectId === subject.id ? 'border-accent bg-accent-soft' : 'border-line bg-paper'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      subjectId === subject.id ? 'text-accent' : 'text-muted'
                    }`}
                  >
                    {subject.emoji ? `${subject.emoji} ` : ''}
                    {subject.moduleCode || subject.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {error ? <Text className="text-xs text-rose">{error}</Text> : null}
      </ScrollView>

      <View className="flex-row items-center gap-2 border-t border-line px-5 py-4">
        {block ? (
          <Button
            label="Delete"
            variant="danger"
            size="sm"
            icon="trash-2"
            onPress={() => onDelete(block.id)}
          />
        ) : null}
        <View className="flex-1" />
        <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} disabled={saving} />
        <Button
          label={block ? 'Save' : 'Add class'}
          size="sm"
          loading={saving}
          disabled={!valid || saving}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}

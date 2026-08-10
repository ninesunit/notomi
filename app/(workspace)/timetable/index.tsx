import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { ImportReview } from '@/components/ImportReview';
import { FadeIn } from '@/components/motion';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import {
  defaultScope,
  filterByTerm,
  TermFilter,
  type TermScope,
} from '@/components/TermFilter';
import { Button, EmptyState, Field, IconButton, Loading, Notice, PageHeader } from '@/components/ui';
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
  ROUTINE_CATEGORIES,
  todayIndex,
  type ClassBlock,
  type RoutineBlock,
  type Semester,
  type Subject,
} from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { getDb } from '@/services/firebase';
import { pickMaterials, type MaterialFile } from '@/services/ingestion';
import {
  academicClasses,
  classesForDay,
  clearTimetable,
  deleteClass,
  deleteRoutine,
  routinesForDay,
  saveClass,
  saveRoutine,
  scanTimetableImage,
  unlinkedClasses,
  type ClassInput,
  type StagedImport,
} from '@/services/timetable';

/**
 * The weekly timetable.
 *
 * It is a real grid at every width — seven day columns against an hour ruler,
 * because that is the shape a student already has in their head, and seeing the
 * whole week at once is the point of a timetable. On a phone the columns take a
 * fixed width and the grid scrolls sideways under a pinned hour ruler, rather
 * than collapsing to one day at a time.
 */

/** Above this width the seven columns share the available space. */
const GRID_BREAKPOINT = 900;
/** Pixels per hour in the grid. Enough for a title and a room at 45 minutes. */
const HOUR_HEIGHT = 56;
/** Width of one day column when the grid scrolls. ~3.5 days visible on a phone. */
const COMPACT_DAY_WIDTH = 96;
/** Width of the pinned hour ruler. */
const RULER_WIDTH = 46;
/** Height of the day-name header, needed to offset the ruler by the same amount. */
const HEADER_HEIGHT = 38;

export default function Timetable() {
  const uid = useUid();
  const db = getDb();
  const { width } = useWindowDimensions();

  const [editing, setEditing] = useState<ClassBlock | 'new' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [showRoutines, setShowRoutines] = useState(true);
  const [editingRoutine, setEditingRoutine] = useState<RoutineBlock | 'new' | null>(null);
  const [staged, setStaged] = useState<StagedImport | null>(null);

  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );

  const allClasses = useCollection<ClassBlock>(
    query(paths.classes(db, uid), orderBy('startMinute', 'asc')),
    [uid]
  );
  const routines = useCollection<RoutineBlock>(
    query(paths.routines(db, uid), orderBy('startMinute', 'asc')),
    [uid]
  );
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);

  /**
   * The grid renders academic blocks only, and only for subjects that still
   * exist and sit in the chosen term. A block whose subject was deleted is
   * surfaced separately rather than drawn as a class the student no longer
   * takes, and last year's classes do not clutter this year's week.
   */
  const [scope, setScope] = useState<TermScope | null>(null);
  const activeScope = scope ?? defaultScope(subjects.data, semesters.data);

  const scopedSubjects = useMemo(
    () => filterByTerm(subjects.data, activeScope, semesters.data),
    [subjects.data, activeScope, semesters.data]
  );

  const classes = useMemo(
    () => ({
      ...allClasses,
      data: academicClasses(allClasses.data, scopedSubjects),
    }),
    [allClasses, scopedSubjects]
  );
  const unlinked = useMemo(
    () => unlinkedClasses(allClasses.data, subjects.data),
    [allClasses.data, subjects.data]
  );

  const grid = width >= GRID_BREAKPOINT;

  /**
   * The visible hour range is derived from the actual schedule, padded by an
   * hour. A fixed 00:00-24:00 ruler would make a normal week a thin band in an
   * ocean of empty night.
   */
  const [firstHour, lastHour] = useMemo(() => {
    const blocks = [
      ...classes.data,
      ...(showRoutines ? routines.data : []),
    ];
    if (blocks.length === 0) return [8, 18];
    const start = Math.min(...blocks.map((block) => block.startMinute));
    const end = Math.max(...blocks.map((block) => block.endMinute));
    return [Math.max(0, Math.floor(start / 60) - 1), Math.min(24, Math.ceil(end / 60) + 1)];
  }, [classes.data, routines.data, showRoutines]);

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
      // Staged, not saved: the student reviews before anything is written.
      setStaged(
        await scanTimetableImage(bytes, file.name, file.mimeType ?? '', subjects.data)
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScanning(false);
    }
  }, [subjects.data]);

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

      {subjects.data.length > 0 ? (
        <TermFilter
          semesters={semesters.data}
          subjects={subjects.data}
          scope={activeScope}
          onScope={setScope}
        />
      ) : null}

      {loading ? (
        <Loading label="Loading your week…" />
      ) : classes.data.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={allClasses.data.length > 0 ? 'No classes in this term' : 'No classes yet'}
          body={
            allClasses.data.length > 0
              ? 'You have classes on other terms. Switch the filter above, or scan this term’s schedule.'
              : 'Take a screenshot of your university schedule and upload it — Gemini reads the grid and fills this in. You can also add classes by hand.'
          }
          action={
            <Button
              label="Scan a screenshot"
              icon="camera"
              loading={scanning}
              onPress={() => void scan()}
            />
          }
        />
      ) : (
        <View className="gap-4">
          {/* The overlay is a layer, not a filter on one list: routines have
              their own collection, so hiding them is a render decision. */}
          <View className="flex-row flex-wrap items-center gap-2">
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: showRoutines }}
              onPress={() => setShowRoutines((value) => !value)}
              className={`flex-row items-center gap-2 rounded-lg border px-3 py-1.5 ${
                showRoutines ? 'border-line bg-sand' : 'border-line bg-surface'
              }`}
            >
              <Feather
                name={showRoutines ? 'eye' : 'eye-off'}
                size={13}
                color={showRoutines ? '#1B1A17' : '#9A9488'}
              />
              <Text
                className={`text-xs font-semibold ${showRoutines ? 'text-ink' : 'text-subtle'}`}
              >
                Routines{routines.data.length > 0 ? ` (${routines.data.length})` : ''}
              </Text>
            </Pressable>

            <Button
              label="Add routine"
              icon="plus"
              variant="ghost"
              size="sm"
              onPress={() => setEditingRoutine('new')}
            />
          </View>

          <WeekGrid
            classes={classes.data}
            routines={showRoutines ? routines.data : []}
            firstHour={firstHour}
            lastHour={lastHour}
            compact={!grid}
            onSelect={(block) => setEditing(block)}
            onSelectRoutine={(block) => setEditingRoutine(block)}
          />

          {unlinked.length > 0 ? (
            <Notice
              tone="amber"
              title={`${unlinked.length} class${unlinked.length === 1 ? '' : 'es'} not linked to a subject`}
              body={`The timetable only shows classes tied to a subject in your library: ${unlinked
                .map((block) => block.title)
                .slice(0, 4)
                .join(', ')}. Open each one and pick its subject, or delete it.`}
            />
          ) : null}
        </View>
      )}

      {unlinked.length > 0 ? (
        <View className="mt-4 gap-2">
          {unlinked.map((block) => (
            <View
              key={block.id}
              className="flex-row items-center gap-3 rounded-xl border border-dashed border-line p-3"
            >
              <Feather name="link-2" size={14} color="#9A9488" />
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {block.title}
              </Text>
              <Text className="text-xs text-subtle">
                {DAY_LABELS[block.day]} {minutesToLabel(block.startMinute)}
              </Text>
              <IconButton icon="edit-2" label={`Link ${block.title}`} onPress={() => setEditing(block)} />
              <IconButton
                icon="trash-2"
                tone="rose"
                label={`Delete ${block.title}`}
                onPress={() => void remove(block.id)}
              />
            </View>
          ))}
        </View>
      ) : null}

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

      {staged ? (
        <ImportReview
          uid={uid}
          rows={staged.rows}
          skipped={staged.skipped}
          semesters={semesters.data}
          onClose={() => setStaged(null)}
          onDone={(outcome) => {
            setStaged(null);
            setNotice(
              `Imported ${outcome.classesAdded} class${
                outcome.classesAdded === 1 ? '' : 'es'
              } across ${outcome.subjectsCreated + outcome.subjectsReused} subject${
                outcome.subjectsCreated + outcome.subjectsReused === 1 ? '' : 's'
              }` +
                (outcome.subjectsCreated > 0
                  ? ` — ${outcome.subjectsCreated} new library folder${
                      outcome.subjectsCreated === 1 ? '' : 's'
                    } created.`
                  : '.')
            );
          }}
        />
      ) : null}

      {editingRoutine !== null ? (
        <RoutineForm
          key={editingRoutine === 'new' ? 'new-routine' : editingRoutine.id}
          uid={uid}
          block={editingRoutine === 'new' ? null : editingRoutine}
          onClose={() => setEditingRoutine(null)}
          onDelete={(id) => {
            setEditingRoutine(null);
            void deleteRoutine(uid, id).catch((caught) => setError(String(caught)));
          }}
        />
      ) : null}
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * The week
 * ------------------------------------------------------------------ */

/** Minutes since midnight, ticking once a minute so the "now" line moves. */
function useNowMinute(): number {
  const read = () => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  };
  const [minute, setMinute] = useState(read);

  useEffect(() => {
    const id = setInterval(() => setMinute(read()), 60_000);
    return () => clearInterval(id);
  }, []);

  return minute;
}

function WeekGrid({
  classes,
  routines,
  firstHour,
  lastHour,
  compact,
  onSelect,
  onSelectRoutine,
}: {
  classes: ClassBlock[];
  routines: RoutineBlock[];
  firstHour: number;
  lastHour: number;
  /** Fixed-width columns that scroll sideways, for phone widths. */
  compact: boolean;
  onSelect: (block: ClassBlock) => void;
  onSelectRoutine: (block: RoutineBlock) => void;
}) {
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const height = hours.length * HOUR_HEIGHT;
  const today = todayIndex();
  const now = useNowMinute();
  const scroller = useRef<ScrollView>(null);

  /**
   * Open on today rather than on Monday. Yesterday is kept in view so the
   * column does not look like the left edge of the week.
   */
  useEffect(() => {
    if (!compact) return;
    const target = Math.max(0, (today - 1) * COMPACT_DAY_WIDTH);
    const id = setTimeout(() => scroller.current?.scrollTo({ x: target, animated: false }), 0);
    return () => clearTimeout(id);
  }, [compact, today]);

  const nowOffset =
    now >= firstHour * 60 && now <= lastHour * 60
      ? ((now - firstHour * 60) / 60) * HOUR_HEIGHT
      : null;

  // Fixed width when scrolling, an equal share of the row when not.
  const columnWidth = compact ? { width: COMPACT_DAY_WIDTH } : undefined;
  const columnFlex = compact ? '' : 'flex-1';

  const week = (
    <View className={compact ? '' : 'flex-1'}>
      <View className="flex-row border-b border-line bg-sand">
        {DAY_LABELS.map((label, index) => (
          <View
            key={label}
            style={[columnWidth, { height: HEADER_HEIGHT }]}
            className={`${columnFlex} items-center justify-center ${
              index === today ? 'bg-accent-soft' : ''
            }`}
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
        {DAY_LABELS.map((label, day) => (
          <View
            key={label}
            style={columnWidth}
            className={`${columnFlex} border-l border-line ${
              day === today ? 'bg-accent-soft/25' : ''
            }`}
          >
            {/* Hour lines sit behind the blocks as ordinary rows. */}
            {hours.map((hour) => (
              <View key={hour} style={{ height: HOUR_HEIGHT }} className="border-b border-line/60" />
            ))}

            {/* Routines are drawn first and inset, so an academic class always
                reads as the thing in front. */}
            {routinesForDay(routines, day).map((block) => {
              const top = ((block.startMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
              const blockHeight = Math.max(
                18,
                ((block.endMinute - block.startMinute) / 60) * HOUR_HEIGHT - 3
              );
              const meta = ROUTINE_CATEGORIES.find((entry) => entry.id === block.category);

              return (
                <Pressable
                  key={block.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${block.title}, ${DAY_FULL[day]} ${minutesToLabel(
                    block.startMinute
                  )}`}
                  onPress={() => {
                    feedback('tap');
                    onSelectRoutine(block);
                  }}
                  className="absolute left-1 right-1 overflow-hidden rounded-lg px-1.5 py-1"
                  style={{
                    top: top + 1,
                    height: blockHeight,
                    backgroundColor: `${block.color}14`,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: `${block.color}59`,
                  }}
                >
                  <Text className="text-[10px] leading-tight text-muted" numberOfLines={1}>
                    {meta?.emoji ?? '📌'} {block.title}
                  </Text>
                </Pressable>
              );
            })}

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
                  onPress={() => {
                    feedback('tap');
                    onSelect(block);
                  }}
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

            {/* Where the day has got to. Drawn last so it crosses the blocks. */}
            {day === today && nowOffset !== null ? (
              <View
                pointerEvents="none"
                className="absolute left-0 right-0 flex-row items-center"
                style={{ top: nowOffset }}
              >
                <View className="h-1.5 w-1.5 rounded-full bg-accent" />
                <View className="h-px flex-1 bg-accent/70" />
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );

  return (
    <FadeIn>
      <View className="overflow-hidden rounded-2xl border border-line bg-surface">
        <View className="flex-row">
          {/* The ruler is a sibling of the scroller, not inside it: the hours
              have to stay put while the days slide under them. */}
          <View className="shrink-0" style={{ width: RULER_WIDTH }}>
            <View
              className="border-b border-r border-line bg-sand"
              style={{ height: HEADER_HEIGHT }}
            />
            <View className="border-r border-line" style={{ height }}>
              {hours.map((hour) => (
                <View key={hour} style={{ height: HOUR_HEIGHT }} className="items-end pr-1.5 pt-1">
                  <Text className="text-[10px] font-medium text-subtle">
                    {minutesToLabel(hour * 60)}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {compact ? (
            <ScrollView
              ref={scroller}
              horizontal
              showsHorizontalScrollIndicator={false}
              className="flex-1"
              // Without an explicit height the scroller collapses to its
              // intrinsic content height on web and clips the grid.
              contentContainerStyle={{ height: HEADER_HEIGHT + height }}
            >
              {week}
            </ScrollView>
          ) : (
            week
          )}
        </View>
      </View>
    </FadeIn>
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
  if (!visible || block === null) return null;

  return (
    <ClassForm
      key={block === 'new' ? 'new' : block.id}
      uid={uid}
      block={block === 'new' ? null : block}
      subjects={subjects}
      onClose={onClose}
      onDelete={onDelete}
    />
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
    <Sheet
      visible
      onClose={onClose}
      title={block ? 'Edit class' : 'Add class'}
      icon="calendar"
      footer={
        <>
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
        </>
      }
    >
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
              hint={!timesValid ? 'e.g. 9:00 AM or 09:00, ending after it starts.' : undefined}
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
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Routine editor — the non-academic overlay
 * ------------------------------------------------------------------ */

function RoutineForm({
  uid,
  block,
  onClose,
  onDelete,
}: {
  uid: string;
  block: RoutineBlock | null;
  onClose: () => void;
  onDelete: (routineId: string) => void;
}) {
  const [title, setTitle] = useState(block?.title ?? '');
  const [category, setCategory] = useState(block?.category ?? ROUTINE_CATEGORIES[0].id);
  const [venue, setVenue] = useState(block?.venue ?? '');
  const [day, setDay] = useState(block?.day ?? todayIndex());
  const [start, setStart] = useState(minutesToClock(block?.startMinute ?? 18 * 60));
  const [end, setEnd] = useState(minutesToClock(block?.endMinute ?? 19 * 60));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  const timesValid = startMinute !== null && endMinute !== null && endMinute > startMinute;
  const valid = title.trim().length > 0 && timesValid;

  const meta = ROUTINE_CATEGORIES.find((option) => option.id === category);

  async function save() {
    if (!valid || startMinute === null || endMinute === null) return;
    setSaving(true);
    setError(null);
    try {
      await saveRoutine(
        uid,
        {
          title: title.trim(),
          category,
          day,
          startMinute,
          endMinute,
          venue: venue.trim() || null,
          color: meta?.color ?? '#6F6A5F',
        },
        block?.id
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <Sheet
      visible
      onClose={onClose}
      title={block ? 'Edit routine' : 'Add routine'}
      icon="clock"
      footer={
        <>
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
            label={block ? 'Save' : 'Add routine'}
            size="sm"
            loading={saving}
            disabled={!valid || saving}
            onPress={() => void save()}
          />
        </>
      }
    >
      <Text className="text-xs leading-5 text-subtle">
        Routines sit over your timetable as a separate layer. They are not subjects, so they never
        appear in your library, your GPA or your notes.
      </Text>

      <Field label="What" value={title} onChangeText={setTitle} placeholder="Gym · Study block" />

      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Type</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {ROUTINE_CATEGORIES.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: category === option.id }}
              onPress={() => setCategory(option.id)}
              className={`flex-row items-center gap-1.5 rounded-lg px-3 py-2 ${
                category === option.id ? 'bg-ink' : 'bg-sand'
              }`}
            >
              <Text className="text-xs">{option.emoji}</Text>
              <Text
                className={`text-xs font-semibold ${
                  category === option.id ? 'text-paper' : 'text-ink'
                }`}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

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
              <Text className={`text-xs font-semibold ${day === index ? 'text-paper' : 'text-ink'}`}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Field label="Starts" value={start} onChangeText={setStart} placeholder="18:00" autoCapitalize="none" />
        </View>
        <View className="flex-1">
          <Field
            label="Ends"
            value={end}
            onChangeText={setEnd}
            placeholder="19:00"
            autoCapitalize="none"
            hint={!timesValid ? 'e.g. 9:00 AM or 09:00, ending after it starts.' : undefined}
          />
        </View>
      </View>

      <Field label="Where (optional)" value={venue} onChangeText={setVenue} placeholder="Sports hall" />

      {error ? <Text className="text-xs text-rose">{error}</Text> : null}
    </Sheet>
  );
}

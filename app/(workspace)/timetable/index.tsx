import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon, useTones } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { ImportReview } from '@/components/ImportReview';
import { FileDropZone } from '@/components/FileDropZone';
import { FadeIn } from '@/components/motion';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { CompactWeekGrid } from '@/components/CompactWeekGrid';
import { AgendaWeek } from '@/components/AgendaWeek';
import { DayFilter } from '@/components/DayFilter';
import { useVisibleDays } from '@/hooks/useVisibleDays';
import { useWeekStyle } from '@/hooks/useWeekStyle';
import { WeekStyleToggle } from '@/components/WeekStyleToggle';
import { laneOut } from '@/lib/timetableLayout';
import { TimeField } from '@/components/TimeField';
import { defaultScope, filterByTerm, TermFilter, type TermScope } from '@/components/TermFilter';
import {
  Button,
  EmptyState,
  Field,
  IconButton,
  Loading,
  Notice,
  PageHeader, Touchable } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useScheduleImport } from '@/hooks/useScheduleImport';
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
import {
  academicClasses,
  classesForDay,
  clearTimetable,
  deleteClass,
  deleteRoutine,
  routinesForDay,
  saveClass,
  saveRoutine,
  unlinkedClasses,
  type ClassInput,
  type ResolvedClass,
} from '@/services/timetable';
import { findActiveSemester } from '@/services/academicPlanner';
import { weekDays, weekOf, weekRangeLabel } from '@/services/teachingPlan';
import { GRID as GRID_BREAKPOINT, PHONE } from '@/lib/breakpoints';
import { TINT, subjectInk, subjectTint } from '@/lib/color';
import { useChromeOffset } from '@/hooks/useChromeOffset';

/**
 * The timetable.
 *
 * Two layouts, one per shape of screen. On a desktop or landscape iPad the week
 * is a grid: seven columns against an hour ruler, the shape a student already
 * has in their head. On a phone it is a single day at full width under a sticky
 * week strip — seven columns on a 390pt screen gave each class forty points and
 * truncated every title, and sideways scrolling to read your own timetable is
 * worse than tapping a day.
 */

/** At or above this width the whole week fits; below it, one day at a time. */


export default function Timetable() {
  const uid = useUid();
  const db = getDb();
  const router = useRouter();
  const params = useLocalSearchParams<{ editClassId?: string }>();
  const { width } = useWindowDimensions();

  const [editing, setEditing] = useState<ClassBlock | 'new' | null>(null);
  /** Failures from editing and deleting; the scan has its own inside the hook. */
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selectedDay, setSelectedDay] = useState(todayIndex());
  /** Phone layout only: the whole week at a glance, or one day on a ruler. */
  const [view, setView] = useState<'week' | 'day'>('week');

  const [showRoutines, setShowRoutines] = useState(true);
  const [editingRoutine, setEditingRoutine] = useState<RoutineBlock | 'new' | null>(null);

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
  /** A phone, where the secondary controls cost more rows than they are worth. */
  const tight = width < PHONE;
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    const editClassId = params.editClassId;
    if (!editClassId || allClasses.loading || editing !== null) return;
    const match = allClasses.data.find((block) => block.id === editClassId);
    if (!match) return;
    setEditing(match);
    router.setParams({ editClassId: undefined });
  }, [params.editClassId, allClasses.loading, allClasses.data, editing, router]);

  /** The term being looked at, so destructive copy can name it. */
  const scopeName =
    activeScope === 'all'
      ? null
      : activeScope === 'unassigned'
        ? 'Unfiled'
        : (semesters.data.find((semester) => semester.id === activeScope)?.name ?? null);

  /**
   * The visible hour range is derived from the actual schedule, padded by an
   * hour. A fixed 00:00-24:00 ruler would make a normal week a thin band in an
   * ocean of empty night.
   */
  // The current-time line on the phone grid needs this at the screen level;
  // the desktop grid calls the same hook internally.
  const nowMinute = useNowMinute();

  const { visibleDays, toggleDay } = useVisibleDays();
  const [style] = useWeekStyle();

  const [firstHour, lastHour] = useMemo(() => {
    const blocks = [...classes.data, ...(showRoutines ? routines.data : [])];
    if (blocks.length === 0) return [8, 18];
    const start = Math.min(...blocks.map((block) => block.startMinute));
    const end = Math.max(...blocks.map((block) => block.endMinute));
    return [Math.max(0, Math.floor(start / 60) - 1), Math.min(24, Math.ceil(end / 60) + 1)];
  }, [classes.data, routines.data, showRoutines]);

  /**
   * The day view gets its own range.
   *
   * Deriving it from the whole week put a Monday with one 9am class on a ruler
   * starting at 2am because some other day had an early block. A day is drawn
   * on a fixed 8-to-6 canvas — the shape of a normal timetable — which then
   * stretches for a 7am lab or an evening lecture.
   */
  const [dayFirst, dayLast] = useMemo(() => {
    const blocks = [
      ...classesForDay(classes.data, selectedDay),
      ...(showRoutines ? routinesForDay(routines.data, selectedDay) : []),
    ];
    if (blocks.length === 0) return [8, 18];

    const start = Math.min(...blocks.map((block) => block.startMinute));
    const end = Math.max(...blocks.map((block) => block.endMinute));
    return [
      Math.min(8, Math.max(0, Math.floor(start / 60) - 1)),
      Math.max(18, Math.min(24, Math.ceil(end / 60) + 1)),
    ];
  }, [classes.data, routines.data, showRoutines, selectedDay]);

  /** Classes per weekday, for the dots on the week strip. */
  const perDay = useMemo(() => {
    const counts = Array(7).fill(0) as number[];
    for (const block of classes.data) counts[block.day] += 1;
    if (showRoutines) for (const block of routines.data) counts[block.day] += 1;
    return counts;
  }, [classes.data, routines.data, showRoutines]);

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

  const importer = useScheduleImport(subjects.data, allClasses.data, routines.data);
  const loading = classes.loading || subjects.loading;

  /**
   * The term the week is being counted against — the one being filtered to if a
   * term is selected, otherwise whichever is running now. A timetable is a
   * repeating shape; the week number and its dates are what tie it to a date.
   */
  const termInView = useMemo(
    () =>
      semesters.data.find((semester) => semester.id === activeScope) ??
      findActiveSemester(semesters.data),
    [semesters.data, activeScope]
  );
  const week = useMemo(() => weekOf(termInView), [termInView]);
  const weekDates = useMemo(
    () => (week ? (weekDays(termInView, week) ?? null) : null),
    [termInView, week]
  );

  return (
    <ScreenScroll>
      <PageHeader
        title="Timetable"
        subtitle={
          // On a phone the count is already visible in the week below it, and
          // the header is the space the week needs.
          !grid && classes.data.length
            ? undefined
            : classes.data.length
              ? `${classes.data.length} class${classes.data.length === 1 ? '' : 'es'} a week`
              : 'Upload up to 10 schedule PDFs, images or slide decks and review the merged week.'
        }
        actions={
          <>
            {/*
              Adding a class is the one thing done often enough to keep in the
              header. Scanning a schedule happens once a term, and the routine
              controls less than that — in front of the grid they cost three
              stacked rows on a phone, which is most of the week they are
              sitting on top of.
            */}
            <Button
              label="Add class"
              icon="plus"
              size="sm"
              onPress={() => setEditing('new')}
            />
            {tight ? (
              <IconButton
                icon="more-horizontal"
                label="More timetable actions"
                onPress={() => setMoreOpen(true)}
              />
            ) : allClasses.data.length > 0 ? (
              <Button
                label={importer.scanning ? 'Reading…' : 'Scan schedule'}
                icon="upload-cloud"
                variant="secondary"
                size="sm"
                loading={importer.scanning}
                disabled={importer.scanning}
                onPress={() => void importer.scan()}
              />
            ) : null}
          </>
        }
      />

      {error || importer.error ? (
        <View className="mb-6">
          <Notice
            title={importer.error ? 'Could not read that timetable' : 'Something went wrong'}
            body={importer.error ?? error ?? ''}
          />
        </View>
      ) : null}

      {importer.notice ? (
        <View className="mb-6">
          <Notice tone="pine" title="Timetable updated" body={importer.notice} />
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

      {/* A timetable is the same seven days every week; this is the line that
          says which week they are. */}
      {week && termInView ? (
        <View className="mb-4 flex-row items-center gap-2 self-start rounded-full border border-line bg-sand px-3 py-1.5">
          <Icon name="calendar" size={13} tone="muted" />
          <Text className="text-xs font-semibold text-ink">Week {week}</Text>
          <Text className="text-xs text-muted">{weekRangeLabel(termInView, week)}</Text>
        </View>
      ) : null}

      {loading ? (
        <Loading label="Loading your week…" />
      ) : classes.data.length === 0 ? (
        allClasses.data.length > 0 ? (
          <EmptyState
            icon="calendar"
            title="No classes in this term"
            body="You have classes in other terms. Switch the filter above, or use Scan schedule to add this term."
          />
        ) : (
          <FileDropZone
            busy={importer.scanning}
            title="Add schedule files"
            body="Drop or choose up to 10 PDF schedules, screenshots, slide decks or ICS calendar exports. Maximum 25 MB per batch."
            onFiles={async (files) => {
              await importer.scanFiles(files);
            }}
          />
        )
      ) : (
        <View className="gap-4">
          {/* The overlay is a layer, not a filter on one list: routines have
              their own collection, so hiding them is a render decision. */}
          <View className={`flex-row flex-wrap items-center gap-2 ${tight ? 'hidden' : ''}`}>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: showRoutines }}
              onPress={() => setShowRoutines((value) => !value)}
              className={`flex-row items-center gap-2 rounded-lg border px-3 py-1.5 ${
                showRoutines ? 'border-line bg-sand' : 'border-line bg-surface'
              }`}
            >
              <Icon
                name={showRoutines ? 'eye' : 'eye-off'}
                size={13}
                tone={showRoutines ? 'ink' : 'subtle'}
              />
              <Text
                className={`text-xs font-semibold ${showRoutines ? 'text-ink' : 'text-subtle'}`}
              >
                Routines
                {routines.data.length > 0 ? ` (${routines.data.length})` : ''}
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

          {/*
            Its own row, and one that survives on a phone.

            The row above is hidden below PHONE on purpose: Routines, Add
            routine and Scan stacked into three lines on top of the week they
            describe. But these two segments went into that row when they were
            added, and inherited the hiding — which left a phone with no way to
            reach either the list view or the day timeline, the second of which
            exists only for phones. Two small segments on one line is not the
            clutter that was removed.
          */}
          <View className="flex-row items-center gap-2">
            <WeekStyleToggle compact={tight} />

            {/* Week is the default: the whole point of a timetable is seeing
                the week. The timeline stays one tap away for the days that
                need the hour-by-hour shape. Phone-only, because a desktop
                shows the whole week and has no day mode — unlike grid versus
                list, which is a preference at every width and the same one the
                dashboard reads. */}
            {grid ? null : (
              <View className="flex-row overflow-hidden rounded-lg border border-line">
                {(['week', 'day'] as const).map((option) => (
                  <Pressable
                    key={option}
                    accessibilityRole="button"
                    accessibilityState={{ selected: view === option }}
                    accessibilityLabel={option === 'week' ? 'Whole week' : 'One day'}
                    onPress={() => {
                      feedback('toggle');
                      setView(option);
                    }}
                    className={`px-3 py-1.5 ${view === option ? 'bg-ink' : 'bg-surface'}`}
                  >
                    <Text
                      className={`text-xs font-semibold ${
                        view === option ? 'text-paper' : 'text-muted'
                      }`}
                    >
                      {option === 'week' ? 'Week' : 'Day'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/*
            Shown exactly when the view on screen obeys it.
            
            The desktop time grid ignores visibleDays, so offering the control
            beside it would be a switch that does nothing. The list obeys it at
            every width — and without this rule a student who hid the weekend on
            their phone would open the desktop list to a weekend-less week with
            no way to bring it back.
          */}
          {view === 'week' && (!grid || style === 'agenda') ? (
            <DayFilter visibleDays={visibleDays} onToggle={toggleDay} />
          ) : null}

          {grid ? (
            style === 'agenda' ? (
              <AgendaWeek
                classes={classes.data}
                routines={showRoutines ? routines.data : []}
                visibleDays={visibleDays}
                dates={weekDates}
                onSelect={(block) => setEditing(block)}
                onSelectRoutine={(block) => setEditingRoutine(block)}
              />
            ) : (
              <WeekGrid
                classes={classes.data}
                routines={showRoutines ? routines.data : []}
                firstHour={firstHour}
                lastHour={lastHour}
                onSelect={(block) => setEditing(block)}
                onSelectRoutine={(block) => setEditingRoutine(block)}
                dates={weekDates}
              />
            )
          ) : view === 'week' ? (
            /*
             * Whichever shape the student asked for. The grid shows that
             * Tuesday is empty until noon and pays for it in legibility; the
             * list gives that up and gets the code, the section and the room
             * back at full size. Neither is the right answer for everyone,
             * which is why it is a setting rather than a breakpoint.
             */
            style === 'agenda' ? (
              <AgendaWeek
                classes={classes.data}
                routines={showRoutines ? routines.data : []}
                visibleDays={visibleDays}
                dates={weekDates}
                onSelect={(block) => setEditing(block)}
                onSelectRoutine={(block) => setEditingRoutine(block)}
              />
            ) : (
              <CompactWeekGrid
                classes={classes.data}
                routines={showRoutines ? routines.data : []}
                visibleDays={visibleDays}
                fitViewport
                dates={weekDates}
                now={nowMinute}
                onSelect={(block) => setEditing(block)}
                onSelectRoutine={(block) => setEditingRoutine(block)}
              />
            )
          ) : (
            <View className="gap-3">
              <WeekStrip
                day={selectedDay}
                onDay={setSelectedDay}
                counts={perDay}
                dates={weekDates}
              />
              <DayTimeline
                day={selectedDay}
                classes={classes.data}
                routines={showRoutines ? routines.data : []}
                firstHour={dayFirst}
                lastHour={dayLast}
                onSelect={(block) => setEditing(block)}
                onSelectRoutine={(block) => setEditingRoutine(block)}
              />
            </View>
          )}

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
              <Icon name="link-2" size={14} tone="subtle" />
              <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                {block.title}
              </Text>
              <Text className="text-xs text-subtle">
                {DAY_LABELS[block.day]} {minutesToLabel(block.startMinute)}
              </Text>
              <IconButton
                icon="edit-2"
                label={`Link ${block.title}`}
                onPress={() => setEditing(block)}
              />
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
                title={
                  scopeName ? `Clear the timetable for ${scopeName}?` : 'Clear the whole timetable?'
                }
                body={`This removes ${classes.data.length} class block${
                  classes.data.length === 1 ? '' : 's'
                }. Your subjects, notes, past terms and program structure all stay exactly as they are — only the weekly blocks go.`}
              />
              <View className="flex-row gap-2">
                <Button
                  label="Yes, clear it"
                  variant="danger"
                  size="sm"
                  icon="trash-2"
                  onPress={() => {
                    setConfirmClear(false);
                    // Scoped to what is on screen: clearing this term must not
                    // take last term's timetable with it.
                    void clearTimetable(
                      uid,
                      classes.data.map((block) => block.id)
                    ).catch((caught) => setError(String(caught)));
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
                label={scopeName ? `Clear ${scopeName}` : 'Clear timetable'}
                variant="danger"
                size="sm"
                icon="trash-2"
                onPress={() => setConfirmClear(true)}
              />
              <Text className="mt-2 text-xs leading-4 text-subtle">
                Clears the weekly class blocks only, ready for a fresh schedule. Your subjects,
                notes and program structure are kept.
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

      {importer.staged ? (
        <ImportReview
          uid={uid}
          rows={importer.staged.rows}
          skipped={importer.staged.skipped}
          semesters={semesters.data}
          onClose={() => importer.setStaged(null)}
          onDone={importer.describe}
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

      <Sheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="Timetable"
        icon="calendar"
        maxHeight={360}
      >
        <View className="gap-2">
          {allClasses.data.length > 0 ? (
            <Button
              label={importer.scanning ? 'Reading…' : 'Scan schedule'}
              icon="upload-cloud"
              variant="secondary"
              loading={importer.scanning}
              disabled={importer.scanning}
              onPress={() => {
                setMoreOpen(false);
                void importer.scan();
              }}
            />
          ) : null}
          <Button
            label="Add routine"
            icon="plus"
            variant="secondary"
            onPress={() => {
              setMoreOpen(false);
              setEditingRoutine('new');
            }}
          />
          <Button
            label={
              showRoutines
                ? 'Hide routines'
                : `Show routines${routines.data.length > 0 ? ` (${routines.data.length})` : ''}`
            }
            icon={showRoutines ? 'eye-off' : 'eye'}
            variant="secondary"
            onPress={() => {
              setShowRoutines((value) => !value);
              setMoreOpen(false);
            }}
          />
        </View>
      </Sheet>
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

/**
 * The day picker that sits above the timeline.
 *
 * Sticky rather than scrolling away: the whole point of a single-day view is
 * that changing day is one tap, and a picker that has scrolled off the top
 * makes it a scroll plus a tap. `position: sticky` is a web-only style, so it
 * is applied through a cast and simply not set anywhere else.
 */
function stickyTop(offset: number): ViewStyle | undefined {
  return Platform.OS === 'web'
    ? ({ position: 'sticky', top: offset, zIndex: 20 } as unknown as ViewStyle)
    : undefined;
}

function WeekStrip({
  day,
  onDay,
  counts,
  dates,
}: {
  day: number;
  onDay: (day: number) => void;
  /** Blocks per weekday, so an empty day is visible before it is opened. */
  counts: number[];
  /** The seven dates of the current teaching week, when a term is running. */
  dates?: Date[] | null;
}) {
  const today = todayIndex();
  /*
   * Pinned below the chrome rather than at zero.
   *
   * `top: 0` sticks this to the top of the scrollport, which is underneath the
   * header and the tab row — so the strip and whatever it was meant to sit
   * below end up occupying the same band. The offset comes from the one place
   * that knows how tall the chrome is, so this cannot drift out of step with
   * a header that changes height.
   */
  const chrome = useChromeOffset();

  return (
    <View style={stickyTop(chrome)} className="-mx-1 bg-paper pb-2 pt-1">
      <View className="flex-row gap-1 px-1">
        {DAY_LABELS.map((label, index) => {
          const active = index === day;
          const count = counts[index] ?? 0;

          return (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${DAY_FULL[index]}${
                dates?.[index] ? ` ${dates[index].getDate()}` : ''
              }, ${count} ${count === 1 ? 'class' : 'classes'}`}
              onPress={() => {
                feedback('toggle');
                onDay(index);
              }}
              className={`flex-1 items-center gap-1 rounded-xl border py-2 ${
                active
                  ? 'border-ink bg-ink'
                  : index === today
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-line bg-surface'
              }`}
            >
              <Text
                className={`text-[11px] font-bold uppercase tracking-wider ${
                  active ? 'text-paper' : index === today ? 'text-accent' : 'text-muted'
                }`}
              >
                {label}
              </Text>
              {/* The date, when a term is running: "Tue" is which slot, "10" is
                  which day, and a student checking a deadline needs both. */}
              {dates?.[index] ? (
                <Text
                  className={`text-[13px] font-semibold tabular-nums ${
                    active ? 'text-paper' : index === today ? 'text-accent' : 'text-ink'
                  }`}
                >
                  {dates[index].getDate()}
                </Text>
              ) : null}
              {/* A dot, not a number: at seven across a phone there is room for
                  presence but not for a count, and presence is the question. */}
              <View
                className={`h-1.5 w-1.5 rounded-full ${
                  count === 0
                    ? 'bg-transparent'
                    : active
                      ? 'bg-paper'
                      : index === today
                        ? 'bg-accent'
                        : 'bg-subtle'
                }`}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Pixels per hour on the single-day timeline. */
const DAY_HOUR_HEIGHT = 76;
/** Width of the hour gutter beside the timeline. */
const GUTTER = 52;

/**
 * One day, full width.
 *
 * Seven columns on a phone gives each class about 40 points to say what it is,
 * which truncates every title to "Introduction to…". A single day gives a block
 * the whole width, so the subject, its code, its room and its hours all fit at
 * a readable size — which is the entire reason this view exists.
 */
function DayTimeline({
  day,
  classes,
  routines,
  firstHour,
  lastHour,
  onSelect,
  onSelectRoutine,
}: {
  day: number;
  classes: ResolvedClass[];
  routines: RoutineBlock[];
  firstHour: number;
  lastHour: number;
  onSelect: (block: ClassBlock) => void;
  onSelectRoutine: (block: RoutineBlock) => void;
}) {
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const height = hours.length * DAY_HOUR_HEIGHT;
  const now = useNowMinute();
  const isToday = day === todayIndex();

  const blocks = classesForDay(classes, day);
  const overlays = routinesForDay(routines, day);

  const nowOffset =
    isToday && now >= firstHour * 60 && now <= lastHour * 60
      ? ((now - firstHour * 60) / 60) * DAY_HOUR_HEIGHT
      : null;

  if (blocks.length === 0 && overlays.length === 0) {
    return (
      <View className="items-center gap-2 rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-12">
        <Icon name="calendar-days" size={24} tone="subtle" />
        <Text className="text-[15px] font-semibold text-ink">Nothing on {DAY_FULL[day]}</Text>
        <Text className="text-center text-sm text-muted">
          {isToday ? 'Your day is clear.' : 'No classes or routines scheduled.'}
        </Text>
      </View>
    );
  }

  /** Fractional position and height of a block on the ruler. */
  const place = (start: number, end: number, minimum: number) => ({
    top: ((start - firstHour * 60) / 60) * DAY_HOUR_HEIGHT,
    height: Math.max(minimum, ((end - start) / 60) * DAY_HOUR_HEIGHT - 6),
  });

  return (
    <View className="overflow-hidden rounded-2xl border border-line bg-surface">
      <View className="flex-row" style={{ height }}>
        <View className="shrink-0 border-r border-line bg-sand/40" style={{ width: GUTTER }}>
          {hours.map((hour) => (
            <View key={hour} style={{ height: DAY_HOUR_HEIGHT }} className="items-end pr-2 pt-1">
              <Text className="text-[11px] font-medium text-subtle">
                {minutesToLabel(hour * 60)}
              </Text>
            </View>
          ))}
        </View>

        <View className="flex-1">
          {hours.map((hour) => (
            <View
              key={hour}
              style={{ height: DAY_HOUR_HEIGHT }}
              className="border-b border-line/60"
            />
          ))}

          {overlays.map((block) => {
            const box = place(block.startMinute, block.endMinute, 34);
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
                className="absolute left-2 right-2 justify-center overflow-hidden rounded-xl px-3"
                style={{
                  top: box.top + 3,
                  height: box.height,
                  backgroundColor: subjectTint(block.color, 0.07),
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: subjectTint(block.color, TINT.edge),
                }}
              >
                <View className="flex-row items-center gap-1.5">
                  <Icon name={meta?.icon ?? 'circle'} size={12} color={subjectInk(block.color)} />
                  <Text className="flex-1 text-[13px] font-medium text-muted" numberOfLines={1}>
                    {block.title}
                  </Text>
                </View>
                <Text className="text-[11px] text-subtle" numberOfLines={1}>
                  {minutesToLabel(block.startMinute)}–{minutesToLabel(block.endMinute)}
                  {block.venue ? ` · ${block.venue}` : ''}
                </Text>
              </Pressable>
            );
          })}

          {blocks.map((block) => {
            const box = place(block.startMinute, block.endMinute, 56);
            const code = block.code;
            const live = isToday && block.startMinute <= now && block.endMinute > now;

            return (
              <Pressable
                key={block.id}
                accessibilityRole="button"
                // The joined subject name, not the stored copy — a renamed course
                // must not keep announcing its old name to a screen reader while
                // the block visibly shows the new one.
                accessibilityLabel={`${block.subjectName || block.title}, ${DAY_FULL[day]} ${minutesToLabel(
                  block.startMinute
                )} to ${minutesToLabel(block.endMinute)}`}
                onPress={() => {
                  feedback('tap');
                  onSelect(block);
                }}
                className="absolute left-2 right-2 justify-center overflow-hidden rounded-xl px-3.5 py-2.5"
                style={{
                  top: box.top + 3,
                  height: box.height,
                  backgroundColor: subjectTint(block.color, 0.12),
                  borderLeftWidth: 4,
                  borderLeftColor: block.color,
                }}
              >
                <View className="flex-row items-center gap-2">
                  {code ? (
                    <Text
                      className="text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: block.color }}
                    >
                      {code}
                    </Text>
                  ) : null}
                  {live ? (
                    <View className="rounded-full bg-accent px-1.5 py-0.5">
                      <Text className="text-[9px] font-bold uppercase tracking-wider text-paper">
                        Now
                      </Text>
                    </View>
                  ) : null}
                </View>

                <Text className="text-[15px] font-semibold leading-5 text-ink" numberOfLines={2}>
                  {block.subjectName || block.title}
                </Text>

                {/* Full width means these never have to be truncated away, and
                    a long room name gets a second line once the block is tall
                    enough to hold one. */}
                {box.height > 62 ? (
                  <Text
                    className="text-xs leading-4 text-muted"
                    numberOfLines={box.height > 96 ? 2 : 1}
                  >
                    {[
                      `${minutesToLabel(block.startMinute)}–${minutesToLabel(block.endMinute)}`,
                      block.section,
                      block.kind,
                      block.venue,
                    ]
                      .filter(Boolean)
                      .join('  ·  ')}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}

          {nowOffset !== null ? (
            <View
              pointerEvents="none"
              className="absolute left-0 right-0 flex-row items-center"
              style={{ top: nowOffset }}
            >
              <View className="h-2 w-2 rounded-full bg-accent" />
              <View className="h-px flex-1 bg-accent/70" />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Wide layout: the whole week at once
 * ------------------------------------------------------------------ */

/** Pixels per hour in the week grid. Enough for a title and a room at 45 minutes. */
const HOUR_HEIGHT = 56;

/**
 * Splits a day's classes into side-by-side lanes.
 *
 * Two classes at the same hour were drawn at the same place, one exactly on top
 * of the other — so a 9–11 lecture hid a 9–10 seminar entirely, and the
 * seminar could not be tapped at all. Each block now takes the leftmost lane
 * that is free at its start, the way every calendar does it.
 */
/** Width of the hour ruler beside the grid. */
const RULER_WIDTH = 46;
/** Height of the day-name header, so the ruler can be offset to match. */
const HEADER_HEIGHT = 38;

function WeekGrid({
  classes,
  routines,
  firstHour,
  lastHour,
  onSelect,
  onSelectRoutine,
  dates,
}: {
  classes: ResolvedClass[];
  routines: RoutineBlock[];
  firstHour: number;
  lastHour: number;
  onSelect: (block: ClassBlock) => void;
  onSelectRoutine: (block: RoutineBlock) => void;
  /** The seven dates of the current teaching week, when a term is running. */
  dates?: Date[] | null;
}) {
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const height = hours.length * HOUR_HEIGHT;
  const today = todayIndex();
  const now = useNowMinute();

  const nowOffset =
    now >= firstHour * 60 && now <= lastHour * 60
      ? ((now - firstHour * 60) / 60) * HOUR_HEIGHT
      : null;

  return (
    <FadeIn>
      <View className="overflow-hidden rounded-2xl border border-line bg-surface">
        <View className="flex-row">
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

          <View className="flex-1">
            <View className="flex-row border-b border-line bg-sand">
              {DAY_LABELS.map((label, index) => (
                <View
                  key={label}
                  style={{ height: HEADER_HEIGHT }}
                  className={`flex-1 flex-row items-center justify-center gap-1.5 ${
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
                  {dates?.[index] ? (
                    <Text
                      className={`text-xs font-semibold tabular-nums ${
                        index === today ? 'text-accent' : 'text-ink'
                      }`}
                    >
                      {dates[index].getDate()}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>

            <View className="flex-row" style={{ height }}>
              {DAY_LABELS.map((label, day) => (
                <View
                  key={label}
                  className={`flex-1 border-l border-line ${
                    day === today ? 'bg-accent-soft/25' : ''
                  }`}
                >
                  {/* Hour lines sit behind the blocks as ordinary rows. */}
                  {hours.map((hour) => (
                    <View
                      key={hour}
                      style={{ height: HOUR_HEIGHT }}
                      className="border-b border-line/60"
                    />
                  ))}

                  {/* Routines are drawn first and inset, so an academic class
                      always reads as the thing in front. */}
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
                          backgroundColor: subjectTint(block.color, 0.08),
                          borderWidth: 1,
                          borderStyle: 'dashed',
                          borderColor: subjectTint(block.color, TINT.edge),
                        }}
                      >
                        <View className="flex-row items-center gap-1">
                          <Icon name={meta?.icon ?? 'circle'} size={9} color={subjectInk(block.color)} />
                          <Text className="flex-1 text-[10px] leading-tight text-muted" numberOfLines={1}>
                            {block.title}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}

                  {laneOut(classesForDay(classes, day)).map(({ block, lane, lanes }) => {
                    const top = ((block.startMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
                    const blockHeight = Math.max(
                      22,
                      ((block.endMinute - block.startMinute) / 60) * HOUR_HEIGHT - 3
                    );

                    return (
                      <Pressable
                        key={block.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${block.subjectName || block.title}, ${DAY_FULL[day]} ${minutesToLabel(
                          block.startMinute
                        )} to ${minutesToLabel(block.endMinute)}`}
                        onPress={() => {
                          feedback('tap');
                          onSelect(block);
                        }}
                        className="absolute overflow-hidden rounded-lg px-1.5 py-1"
                        style={{
                          top: top + 1,
                          height: blockHeight,
                          // Percentages rather than fixed insets, so the column
                          // keeps working at every screen width.
                          left: `${(lane / lanes) * 100}%`,
                          width: `${(1 / lanes) * 100}%`,
                          backgroundColor: subjectTint(block.color, TINT.fill),
                          borderLeftWidth: 3,
                          borderLeftColor: block.color,
                        }}
                      >
                        <Text
                          className="text-[11px] font-semibold leading-tight text-ink"
                          numberOfLines={2}
                        >
                          {/* The subject's own name, joined on render, so a
                              rename in the library shows here immediately. */}
                          {block.subjectName || block.title}
                        </Text>
                        {blockHeight > 42 ? (
                          <Text className="text-[10px] leading-tight text-muted" numberOfLines={1}>
                            {[
                              block.section || block.code,
                              minutesToLabel(block.startMinute),
                              block.venue,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}

                  {/* Where the day has got to. Drawn last so it crosses the
                      blocks. */}
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
        </View>
      </View>
    </FadeIn>
  );
}

/* ------------------------------------------------------------------ *
 * Add / edit a class
 * ------------------------------------------------------------------ */

/**
 * Weekday chips, multi-select when adding.
 *
 * The same control serves classes and routines, because "which days does this
 * happen on" is the same question for a lecture and for the gym.
 */
function DayPicker({
  days,
  multiple,
  onToggle,
  hint,
}: {
  days: number[];
  multiple: boolean;
  onToggle: (day: number) => void;
  hint?: string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted">{multiple ? 'Which days?' : 'Day'}</Text>

      <View className="flex-row flex-wrap gap-1.5">
        {DAY_LABELS.map((label, index) => {
          const selected = days.includes(index);
          return (
            <Pressable
              key={label}
              accessibilityRole={multiple ? 'checkbox' : 'button'}
              accessibilityState={{ selected, checked: selected }}
              // react-native-web does not emit aria-checked from
              // accessibilityState here, so a screen reader would announce a
              // checkbox with no state. Set it directly.
              aria-checked={multiple ? selected : undefined}
              accessibilityLabel={DAY_FULL[index]}
              onPress={() => {
                feedback('toggle');
                onToggle(index);
              }}
              className={`min-w-[46px] items-center rounded-lg px-3 py-2 ${
                selected ? 'bg-ink' : 'bg-sand'
              }`}
            >
              <Text className={`text-xs font-semibold ${selected ? 'text-paper' : 'text-ink'}`}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {hint ? <Text className="text-xs leading-4 text-subtle">{hint}</Text> : null}
    </View>
  );
}

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
  const [section, setSection] = useState(block?.section ?? '');
  const [venue, setVenue] = useState(block?.venue ?? '');
  /**
   * Days, plural.
   *
   * A lecture that meets Monday and Thursday is one thing a student adds once,
   * not two identical forms filled in twice. Editing stays single-day: an
   * existing block is one occurrence, and turning it into three from its own
   * editor would be a surprise rather than a shortcut.
   */
  const [days, setDays] = useState<number[]>([block?.day ?? todayIndex()]);
  const [startMinute, setStartMinute] = useState(block?.startMinute ?? 9 * 60);
  const [endMinute, setEndMinute] = useState(block?.endMinute ?? 10 * 60);
  const [subjectId, setSubjectId] = useState<string | null>(block?.subjectId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timesValid = endMinute > startMinute;

  const linked = subjects.find((candidate) => candidate.id === subjectId) ?? null;
  // A session is identified by its subject; only an unlinked block needs a name
  // typed for it.
  const valid = (linked !== null || title.trim().length > 0) && timesValid && days.length > 0;

  const toggleDay = (index: number) =>
    setDays((current) => {
      if (block) return [index];
      if (current.includes(index)) {
        // Never leave it with none selected — that would just disable Save.
        return current.length === 1 ? current : current.filter((day) => day !== index);
      }
      return [...current, index].sort((a, b) => a - b);
    });

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);

    const subject = linked;
    const shared = {
      // Derived, not typed: the subject owns the name, and storing a divergent
      // copy here is exactly what stopped a library rename reaching the grid.
      title: subject ? subject.name : title.trim(),
      kind: kind.trim() || null,
      section: section.trim() || null,
      subjectId: subject?.id ?? null,
      subjectName: subject?.name ?? null,
      startMinute,
      endMinute,
      venue: venue.trim() || null,
      color: subject?.color || block?.color || colorForSubject(title || 'class'),
    };

    try {
      // One write per day. Editing passes the block id so the first (and only)
      // day updates in place instead of adding a duplicate.
      for (const day of days) {
        const input: ClassInput = { ...shared, day };
        await saveClass(uid, input, block?.id);
      }
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
      variant="fullscreen-mobile"
      primaryAction={{
        label: block ? 'Save' : days.length > 1 ? `Add ${days.length}` : 'Add',
        onPress: () => void save(),
        disabled: !valid,
        loading: saving,
      }}
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
            label={block ? 'Save' : days.length > 1 ? `Add ${days.length} classes` : 'Add class'}
            size="sm"
            loading={saving}
            disabled={!valid || saving}
            onPress={() => void save()}
          />
        </>
      }
    >
      {subjects.length > 0 ? (
        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Subject</Text>
          <Text className="text-xs leading-4 text-subtle">
            Name, code and colour come from the library.
          </Text>
          <View className="flex-row flex-wrap gap-1.5">
            {subjects.map((subject) => (
              <Pressable
                key={subject.id}
                accessibilityRole="button"
                accessibilityState={{ selected: subjectId === subject.id }}
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
                  {subject.moduleCode || subject.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {linked ? (
        <View className="flex-row items-center gap-3 rounded-xl border border-line bg-paper p-3">
          <View className="h-2 w-2 rounded-full" style={{ backgroundColor: linked.color }} />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">{linked.name}</Text>
            <Text className="text-xs text-subtle">
              {linked.moduleCode ? `${linked.moduleCode} · ` : ''}Named by the library
            </Text>
          </View>
        </View>
      ) : (
        <Field
          label="Class"
          value={title}
          onChangeText={setTitle}
          placeholder="CS2040 Lecture"
          hint="Pick a subject above to have this named for you."
        />
      )}

      <DayPicker
        days={days}
        multiple={!block}
        onToggle={toggleDay}
        hint={
          block
            ? 'This is one occurrence. Add another for a second day.'
            : 'Pick every day this session runs — one block is created for each.'
        }
      />

      <View className="gap-3">
        <TimeField label="Starts" value={startMinute} onChange={setStartMinute} />
        <TimeField
          label="Ends"
          value={endMinute}
          onChange={setEndMinute}
          invalid={!timesValid}
          hint={!timesValid ? 'The end has to come after the start.' : undefined}
        />
      </View>

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Field label="Session type" value={kind} onChangeText={setKind} placeholder="Lecture" />
        </View>
        <View className="flex-1">
          <Field
            label="Section"
            value={section}
            onChangeText={setSection}
            placeholder="TC1L"
            autoCapitalize="characters"
          />
        </View>
      </View>

      <Field label="Room" value={venue} onChangeText={setVenue} placeholder="LT-15" />

      {block ? (
        <Button
          label="Delete class"
          variant="danger"
          icon="trash-2"
          onPress={() => onDelete(block.id)}
          className="sm:hidden"
        />
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
  const tones = useTones();
  const [title, setTitle] = useState(block?.title ?? '');
  const [category, setCategory] = useState(block?.category ?? ROUTINE_CATEGORIES[0].id);
  const [venue, setVenue] = useState(block?.venue ?? '');
  /** Gym on Monday, Wednesday and Friday is one routine, added once. */
  const [days, setDays] = useState<number[]>([block?.day ?? todayIndex()]);
  const [startMinute, setStartMinute] = useState(block?.startMinute ?? 18 * 60);
  const [endMinute, setEndMinute] = useState(block?.endMinute ?? 19 * 60);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timesValid = endMinute > startMinute;
  const valid = title.trim().length > 0 && timesValid && days.length > 0;

  const toggleDay = (index: number) =>
    setDays((current) => {
      if (block) return [index];
      if (current.includes(index)) {
        return current.length === 1 ? current : current.filter((day) => day !== index);
      }
      return [...current, index].sort((a, b) => a - b);
    });

  const meta = ROUTINE_CATEGORIES.find((option) => option.id === category);

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      for (const day of days) {
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
      }
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
      variant="fullscreen-mobile"
      primaryAction={{
        label: block ? 'Save' : days.length > 1 ? `Add ${days.length}` : 'Add',
        onPress: () => void save(),
        disabled: !valid,
        loading: saving,
      }}
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
            label={block ? 'Save' : days.length > 1 ? `Add ${days.length} routines` : 'Add routine'}
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
              <Icon
                name={option.icon}
                size={13}
                color={category === option.id ? tones.inverse : subjectInk(option.color)}
              />
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

      <DayPicker
        days={days}
        multiple={!block}
        onToggle={toggleDay}
        hint={
          block
            ? 'This is one occurrence. Add another for a second day.'
            : 'Pick every day it runs — gym on Mon, Wed and Fri is one routine.'
        }
      />

      <View className="gap-3">
        <TimeField label="Starts" value={startMinute} onChange={setStartMinute} />
        <TimeField
          label="Ends"
          value={endMinute}
          onChange={setEndMinute}
          invalid={!timesValid}
          hint={!timesValid ? 'The end has to come after the start.' : undefined}
        />
      </View>

      <Field
        label="Where (optional)"
        value={venue}
        onChangeText={setVenue}
        placeholder="Sports hall"
      />

      {block ? (
        <Button
          label="Delete routine"
          variant="danger"
          icon="trash-2"
          onPress={() => onDelete(block.id)}
          className="sm:hidden"
        />
      ) : null}

      {error ? <Text className="text-xs text-rose">{error}</Text> : null}
    </Sheet>
  );
}

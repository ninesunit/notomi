import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Sheet } from './Sheet';
import { Reveal } from './motion';
import { Button, Field, Notice } from './ui';
import {
  DAY_LABELS,
  knownTerms,
  minutesToLabel,
  parseClock,
  TERM_SUGGESTIONS,
  type Semester,
} from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { createSemester } from '@/services/program';
import {
  commitImport,
  flattenImportGroups,
  groupImportRows,
  type ImportGroup,
  type ImportOutcome,
  type ImportRow,
} from '@/services/timetable';

/**
 * Review before import.
 *
 * Vision reads a schedule well but not perfectly, and this import writes into
 * three places at once — the library, the timetable and the program structure.
 * Writing all that from an unreviewed guess would leave a student cleaning up
 * folders they never asked for, so nothing is committed until they have seen
 * every session and chosen the term it belongs to.
 *
 * The review is hierarchical, not flat. A screenshot of a normal week produces
 * eight or ten blocks across three or four courses, and a flat list asked the
 * student to retype the same course code and subject name for every one of
 * them. Here the subject is the card and its sessions are rows inside it: the
 * code and the name are typed once, at the top, and apply to everything under
 * them. Only what genuinely differs per block — type, day, times, room — is
 * editable per row.
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
  const [groups, setGroups] = useState<ImportGroup[]>(() => groupImportRows(initialRows));
  /** Only one subject card is open at a time; the sheet is short. */
  const [expanded, setExpanded] = useState<string | null>(
    () => groupImportRows(initialRows)[0]?.id ?? null
  );
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

  const includedGroups = groups.filter(
    (group) => group.include && group.sessions.some((session) => session.include)
  );
  const includedSessions = includedGroups.reduce(
    (total, group) => total + group.sessions.filter((session) => session.include).length,
    0
  );
  const totalSessions = groups.reduce((total, group) => total + group.sessions.length, 0);

  /** Edit the subject: one write, applied to every session beneath it. */
  const patchGroup = (id: string, change: Partial<ImportGroup>) =>
    setGroups((previous) =>
      previous.map((group) => (group.id === id ? { ...group, ...change } : group))
    );

  /** Edit one session, leaving its siblings alone. */
  const patchSession = (groupId: string, sessionId: string, change: Partial<ImportRow>) =>
    setGroups((previous) =>
      previous.map((group) =>
        group.id === groupId
          ? {
              ...group,
              sessions: group.sessions.map((session) =>
                session.id === sessionId ? { ...session, ...change } : session
              ),
            }
          : group
      )
    );

  async function confirm() {
    if (includedSessions === 0) return;
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

      const outcome = await commitImport(uid, flattenImportGroups(groups), {
        semesterId: targetSemester,
      });
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
              : `${includedGroups.length} ${
                  includedGroups.length === 1 ? 'subject' : 'subjects'
                } · ${includedSessions} of ${totalSessions} sessions`}
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
            disabled={saving || (!discarding && includedSessions === 0)}
            onPress={() => (discarding ? setDiscarding(false) : void confirm())}
          />
        </>
      }
    >
      <Text className="text-xs leading-5 text-subtle">
        Check this before it is saved. Importing creates one library folder per subject, fills
        your weekly timetable, and files everything under the term you choose.
      </Text>

      {skipped > 0 ? (
        <Notice
          tone="amber"
          title={`${skipped} row${skipped === 1 ? '' : 's'} could not be read`}
          body="Their day or time was unreadable, so they were left out rather than guessed at. Add them by hand after importing."
        />
      ) : null}

      {/* Term first: it applies to every subject, so choosing it after editing
          four cards would be the wrong order. */}
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

      <View className="gap-2.5">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-medium text-muted">
            {groups.length} {groups.length === 1 ? 'subject' : 'subjects'} detected
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              setGroups((previous) => {
                const turningOn = includedGroups.length !== previous.length;
                return previous.map((group) => ({ ...group, include: turningOn }));
              })
            }
            hitSlop={6}
          >
            <Text className="text-xs font-semibold text-accent">
              {includedGroups.length === groups.length ? 'Deselect all' : 'Select all'}
            </Text>
          </Pressable>
        </View>

        {groups.map((group) => (
          <SubjectCard
            key={group.id}
            group={group}
            open={expanded === group.id}
            onToggleOpen={() => setExpanded(expanded === group.id ? null : group.id)}
            onPatch={(change) => patchGroup(group.id, change)}
            onPatchSession={(sessionId, change) => patchSession(group.id, sessionId, change)}
          />
        ))}
      </View>

      {error ? <Notice title="Import failed" body={error} /> : null}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * One subject and its sessions
 * ------------------------------------------------------------------ */

function SubjectCard({
  group,
  open,
  onToggleOpen,
  onPatch,
  onPatchSession,
}: {
  group: ImportGroup;
  open: boolean;
  onToggleOpen: () => void;
  onPatch: (change: Partial<ImportGroup>) => void;
  onPatchSession: (sessionId: string, change: Partial<ImportRow>) => void;
}) {
  const active = group.sessions.filter((session) => session.include).length;

  return (
    <View
      className={`gap-3 rounded-xl border p-3 ${
        group.include ? 'border-line bg-surface' : 'border-line bg-paper opacity-60'
      }`}
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: group.include }}
          accessibilityLabel={`Include ${group.title || group.code}`}
          onPress={() => {
            feedback('toggle');
            onPatch({ include: !group.include });
          }}
          className={`h-5 w-5 items-center justify-center rounded-md border ${
            group.include ? 'border-pine bg-pine' : 'border-subtle bg-surface'
          }`}
        >
          {group.include ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${open ? 'Collapse' : 'Edit'} ${group.title || group.code}`}
          className="flex-1"
          onPress={onToggleOpen}
        >
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
            {[group.code, group.title].filter(Boolean).join(' · ') || 'Untitled subject'}
          </Text>
          <Text className="text-xs text-muted" numberOfLines={1}>
            {active} {active === 1 ? 'session' : 'sessions'}
            {group.existingSubjectId ? ' · existing folder' : ' · new folder'}
          </Text>
        </Pressable>

        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color="#6F6A5F" />
      </View>

      <Reveal open={open}>
        <View className="gap-3 border-t border-line pt-3">
          {/* Subject level: typed once, applied to every session below. */}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Field
                label="Course code"
                value={group.code}
                onChangeText={(value) => onPatch({ code: value })}
                placeholder="CS2040"
                autoCapitalize="characters"
              />
            </View>
            <View className="flex-[2]">
              <Field
                label="Subject name"
                value={group.title}
                onChangeText={(value) => onPatch({ title: value })}
                placeholder="Data Structures"
              />
            </View>
          </View>

          <Text className="-mt-1 text-[11px] leading-4 text-subtle">
            Used for the library folder and every class block below it. Change it here and it
            changes everywhere.
          </Text>

          <View className="gap-2">
            <Text className="text-xs font-bold uppercase tracking-wider text-muted">Sessions</Text>
            {group.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                onPatch={(change) => onPatchSession(session.id, change)}
              />
            ))}
          </View>
        </View>
      </Reveal>
    </View>
  );
}

function SessionRow({
  session,
  onPatch,
}: {
  session: ImportRow;
  onPatch: (change: Partial<ImportRow>) => void;
}) {
  const startMinute = parseClock(session.start);
  const endMinute = parseClock(session.end);
  const timesValid = startMinute !== null && endMinute !== null && endMinute > startMinute;

  return (
    <View
      className={`gap-2.5 rounded-lg border border-line p-2.5 ${
        session.include ? 'bg-paper' : 'bg-sand opacity-60'
      }`}
    >
      <View className="flex-row items-center gap-2.5">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: session.include }}
          accessibilityLabel={`Include ${session.kind || 'session'} on ${DAY_LABELS[session.day]}`}
          onPress={() => onPatch({ include: !session.include })}
          className={`h-[18px] w-[18px] items-center justify-center rounded border ${
            session.include ? 'border-pine bg-pine' : 'border-subtle bg-surface'
          }`}
        >
          {session.include ? <Feather name="check" size={10} color="#FFFFFF" /> : null}
        </Pressable>

        <Text className="flex-1 text-xs font-medium text-ink" numberOfLines={1}>
          {[session.section, session.kind].filter(Boolean).join(' ') || 'Session'} ·{' '}
          {DAY_LABELS[session.day]}{' '}
          {timesValid && startMinute !== null && endMinute !== null
            ? `${minutesToLabel(startMinute)}–${minutesToLabel(endMinute)}`
            : `${session.start}–${session.end}`}
        </Text>
      </View>

      <View className="flex-row gap-2">
        <View className="flex-1">
          <Field
            label="Section"
            value={session.section}
            onChangeText={(value) => onPatch({ section: value })}
            placeholder="TC1L"
            autoCapitalize="characters"
          />
        </View>
        <View className="flex-1">
          <Field
            label="Type"
            value={session.kind}
            onChangeText={(value) => onPatch({ kind: value })}
            placeholder="Lecture"
          />
        </View>
      </View>

      <Field
        label="Room"
        value={session.venue}
        onChangeText={(value) => onPatch({ venue: value })}
        placeholder="LT-15"
      />

      <View className="gap-1.5">
        <Text className="text-sm font-medium text-muted">Day</Text>
        <View className="flex-row flex-wrap gap-1">
          {DAY_LABELS.map((label, index) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityState={{ selected: session.day === index }}
              onPress={() => onPatch({ day: index })}
              className={`rounded-lg px-2.5 py-1.5 ${
                session.day === index ? 'bg-ink' : 'bg-sand'
              }`}
            >
              <Text
                className={`text-[11px] font-semibold ${
                  session.day === index ? 'text-paper' : 'text-ink'
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
            value={session.start}
            onChangeText={(value) => onPatch({ start: value })}
            placeholder="09:00"
            autoCapitalize="none"
          />
        </View>
        <View className="flex-1">
          <Field
            label="Ends"
            value={session.end}
            onChangeText={(value) => onPatch({ end: value })}
            placeholder="11:00"
            autoCapitalize="none"
            hint={!timesValid ? 'e.g. 9:00 AM or 09:00, ending after it starts.' : undefined}
          />
        </View>
      </View>
    </View>
  );
}

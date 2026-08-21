import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Icon, useTones } from '@/components/Icon';
import { orderBy, query, Timestamp } from 'firebase/firestore';
import { useCollection } from '@/hooks/useFirestore';
import { formatDue, toDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import { feedback } from '@/lib/sound';
import {
  ASSIGNMENT_KINDS,
  type Assignment,
  type AssignmentKind,
  type AssignmentStep,
} from '@/lib/schema';
import {
  analyseBrief,
  deleteAssignment,
  progressOf,
  saveAssignment,
  setAssignmentStatus,
  toSaveInput,
  toggleStep,
  type SaveInput,
} from '@/services/assignments';
import { getDb } from '@/services/firebase';
import { pickMaterials, type MaterialFile } from '@/services/ingestion';
import { DatePicker } from './DatePicker';
import { Markdown } from './Markdown';
import { FadeIn, Reveal } from './motion';
import { Sheet } from './Sheet';
import { Badge, Button, Card, EmptyState, IconButton, Loading, Notice } from './ui';
import { subjectInk, subjectTint } from '@/lib/color';

/**
 * Tutorials, labs and assignments for one subject.
 *
 * The flow is deliberately one-way: drop in the brief, look at what Gemini made
 * of it, save. Nothing is written until the student has seen the deadline it
 * read — a wrong date silently entering the calendar is worse than no date.
 */
export function AssignmentsPanel({
  uid,
  subjectId,
  subjectName,
}: {
  uid: string;
  subjectId: string;
  subjectName: string;
}) {
  const db = getDb();
  const assignments = useCollection<Assignment>(
    query(paths.assignments(db, uid, subjectId), orderBy('createdAt', 'desc')),
    [uid, subjectId]
  );

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [open, done] = useMemo(() => {
    const rows = assignments.data;
    return [
      rows.filter((row) => row.status !== 'done'),
      rows.filter((row) => row.status === 'done'),
    ];
  }, [assignments.data]);

  return (
    <View className="gap-6">
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          label="Add a brief"
          icon="upload-cloud"
          size="sm"
          onPress={() => {
            setError(null);
            setAdding(true);
          }}
        />
        <Text className="flex-1 text-xs leading-4 text-subtle" style={{ minWidth: 180 }}>
          Upload the task sheet or paste it. Notomi breaks it into steps and puts the deadline in
          your calendar.
        </Text>
      </View>

      {error ? <Notice title="Something went wrong" body={error} /> : null}

      {assignments.loading ? (
        <Loading label="Loading your tasks…" />
      ) : assignments.data.length === 0 ? (
        <EmptyState
          icon="clipboard"
          title="No tutorials, labs or assignments yet"
          body="Add the brief for a piece of work and Notomi turns it into a checklist with a deadline — the same deadline your calendar and to-dos read from."
          action={<Button label="Add a brief" icon="upload-cloud" onPress={() => setAdding(true)} />}
        />
      ) : (
        <View className="gap-6">
          <View className="gap-3">
            {open.map((assignment, index) => (
              <FadeIn key={assignment.id} index={index}>
                <AssignmentCard uid={uid} assignment={assignment} onError={setError} />
              </FadeIn>
            ))}
            {open.length === 0 ? (
              <Text className="text-sm text-muted">Everything here is done.</Text>
            ) : null}
          </View>

          {done.length > 0 ? (
            <View className="gap-3">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                  Completed
                </Text>
                <View className="h-px flex-1 bg-line" />
                <Text className="text-xs text-subtle">{done.length}</Text>
              </View>
              {done.map((assignment) => (
                <AssignmentCard
                  key={assignment.id}
                  uid={uid}
                  assignment={assignment}
                  onError={setError}
                />
              ))}
            </View>
          ) : null}
        </View>
      )}

      {adding ? (
        <AddAssignment
          uid={uid}
          subjectId={subjectId}
          subjectName={subjectName}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * One task
 * ------------------------------------------------------------------ */

function AssignmentCard({
  uid,
  assignment,
  onError,
}: {
  uid: string;
  assignment: Assignment;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const meta = ASSIGNMENT_KINDS.find((entry) => entry.id === assignment.kind) ?? ASSIGNMENT_KINDS[0];
  const due = toDate(assignment.dueDate);
  const progress = progressOf(assignment);
  const isDone = assignment.status === 'done';
  const overdue = !isDone && due !== null && due.getTime() < Date.now();

  const guard = (action: Promise<unknown>) =>
    void action.catch((caught: unknown) =>
      onError(caught instanceof Error ? caught.message : String(caught))
    );

  return (
    <Card className={`gap-3 ${isDone ? 'opacity-60' : ''}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${assignment.title}`}
        onPress={() => {
          feedback('tap');
          setOpen((value) => !value);
        }}
        className="flex-row items-start gap-3"
      >
        <View
          className="mt-0.5 h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: subjectTint(meta.color, 0.12) }}
        >
          <Icon name={meta.icon} size={17} color={subjectInk(meta.color)} />
        </View>

        <View className="flex-1 gap-1.5">
          <Text
            className={`text-[15px] font-semibold leading-5 text-ink ${
              isDone ? 'line-through' : ''
            }`}
          >
            {assignment.title}
          </Text>

          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-xs font-semibold" style={{ color: meta.color }}>
              {meta.label}
            </Text>
            {due ? (
              <Text className={`text-xs ${overdue ? 'font-semibold text-rose' : 'text-subtle'}`}>
                · {formatDue(due)}
              </Text>
            ) : (
              <Text className="text-xs text-subtle">· No deadline</Text>
            )}
            {assignment.estimatedHours ? (
              <Text className="text-xs text-subtle">· ~{assignment.estimatedHours} h</Text>
            ) : null}
          </View>

          {progress !== null ? (
            <View className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sand">
              <View
                className="h-full rounded-full"
                style={{ width: `${Math.round(progress * 100)}%`, backgroundColor: meta.color }}
              />
            </View>
          ) : null}
        </View>

        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} tone="subtle" />
      </Pressable>

      <Reveal open={open}>
        <View className="gap-4 border-t border-line pt-4">
          {assignment.brief ? (
            <View className="gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                What is being asked
              </Text>
              <Markdown source={assignment.brief} />
            </View>
          ) : null}

          {assignment.steps.length > 0 ? (
            <View className="gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">Plan</Text>
              {assignment.steps.map((step) => (
                <Pressable
                  key={step.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: step.isCompleted }}
                  accessibilityLabel={step.title}
                  onPress={() => {
                    feedback(step.isCompleted ? 'toggle' : 'success');
                    guard(toggleStep(uid, assignment, step.id));
                  }}
                  className="flex-row items-start gap-3 rounded-xl bg-paper p-3"
                >
                  <View
                    className={`mt-0.5 h-[18px] w-[18px] items-center justify-center rounded-md border ${
                      step.isCompleted ? 'border-pine bg-pine' : 'border-line bg-surface'
                    }`}
                  >
                    {step.isCompleted ? <Icon name="check" size={11} tone="inverse" /> : null}
                  </View>
                  <View className="flex-1 gap-0.5">
                    <Text
                      className={`text-sm font-medium leading-5 ${
                        step.isCompleted ? 'text-subtle line-through' : 'text-ink'
                      }`}
                    >
                      {step.title}
                    </Text>
                    {step.detail ? (
                      <Text className="text-xs leading-5 text-muted">{step.detail}</Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}

          {assignment.deliverables.length > 0 ? (
            <View className="gap-2">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                Hand in
              </Text>
              {assignment.deliverables.map((item) => (
                <View key={item} className="flex-row gap-2">
                  <Icon name="package" size={13} tone="muted" style={{ marginTop: 3 }} />
                  <Text className="flex-1 text-sm leading-5 text-ink">{item}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {assignment.markingNotes ? (
            <View className="gap-1.5 rounded-xl bg-sand p-3.5">
              <Text className="text-xs font-bold uppercase tracking-wider text-muted">Marking</Text>
              <Text className="text-sm leading-5 text-ink">{assignment.markingNotes}</Text>
            </View>
          ) : null}

          {assignment.sourceFileName ? (
            <Text className="text-[11px] text-subtle">From {assignment.sourceFileName}</Text>
          ) : null}

          {confirming ? (
            <View className="gap-2">
              <Notice
                tone="rose"
                title={`Delete “${assignment.title}”?`}
                body="This also removes the to-do and calendar entry it created."
              />
              <View className="flex-row gap-2">
                <Button
                  label="Yes, delete"
                  variant="danger"
                  size="sm"
                  icon="trash-2"
                  onPress={() => {
                    setConfirming(false);
                    guard(deleteAssignment(uid, assignment.subjectId, assignment.id));
                  }}
                />
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onPress={() => setConfirming(false)}
                />
              </View>
            </View>
          ) : (
            <View className="flex-row flex-wrap items-center gap-2">
              <Button
                label={isDone ? 'Reopen' : 'Mark done'}
                icon={isDone ? 'rotate-ccw' : 'check-circle'}
                variant={isDone ? 'ghost' : 'secondary'}
                size="sm"
                onPress={() => {
                  feedback(isDone ? 'toggle' : 'complete');
                  guard(
                    setAssignmentStatus(
                      uid,
                      assignment.subjectId,
                      assignment.id,
                      isDone ? 'todo' : 'done'
                    )
                  );
                }}
              />
              <View className="flex-1" />
              <IconButton
                icon="trash-2"
                tone="rose"
                label={`Delete ${assignment.title}`}
                onPress={() => setConfirming(true)}
              />
            </View>
          )}
        </View>
      </Reveal>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Add a brief
 * ------------------------------------------------------------------ */

type Draft = SaveInput & { steps: AssignmentStep[] };

function AddAssignment({
  uid,
  subjectId,
  subjectName,
  onClose,
}: {
  uid: string;
  subjectId: string;
  subjectName: string;
  onClose: () => void;
}) {
  const tones = useTones();
  const [pasted, setPasted] = useState('');
  const [file, setFile] = useState<MaterialFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  async function pick() {
    setError(null);
    try {
      const picked = await pickMaterials();
      if (picked.length > 0) setFile(picked[0]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const { breakdown, sourceText, fileName } = await analyseBrief({
        subjectId,
        subjectName,
        file: file ?? undefined,
        text: pasted,
      });
      setDraft(toSaveInput(subjectId, subjectName, breakdown, sourceText, fileName));
      feedback('success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await saveAssignment(uid, draft);
      feedback('complete');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  const canAnalyse = Boolean(file || pasted.trim().length > 40);

  return (
    <Sheet
      visible
      onClose={onClose}
      title={draft ? 'Check this before saving' : 'Add a brief'}
      icon="clipboard"
      maxHeight={520}
      // The reading cost real time and a Gemini call; a stray tap outside must
      // not throw it away.
      dismissOnScrim={!draft}
      footer={
        draft ? (
          <>
            <Button
              label="Start over"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={() => setDraft(null)}
            />
            <View className="flex-1" />
            <Button
              label="Save task"
              icon="check"
              size="sm"
              loading={busy}
              disabled={busy}
              onPress={() => void save()}
            />
          </>
        ) : (
          <>
            <Button label="Cancel" variant="ghost" size="sm" disabled={busy} onPress={onClose} />
            <View className="flex-1" />
            <Button
              label={busy ? 'Reading…' : 'Read the brief'}
              icon="zap"
              size="sm"
              loading={busy}
              disabled={!canAnalyse || busy}
              onPress={() => void analyse()}
            />
          </>
        )
      }
    >
      {draft ? (
        <DraftReview draft={draft} onChange={setDraft} />
      ) : (
        <>
          <Text className="text-xs leading-5 text-subtle">
            A tutorial sheet, lab manual or assignment spec — PDF, DOCX, PPTX, an image of a
            printout, or plain text.
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose a file"
            onPress={() => void pick()}
            className="flex-row items-center gap-3 rounded-xl border border-dashed border-line bg-paper p-4"
          >
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
              <Icon name={file ? 'file-text' : 'upload-cloud'} size={16} tone="muted" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                {file ? file.name : 'Choose a file'}
              </Text>
              <Text className="text-xs text-subtle">
                {file ? 'Tap to pick a different one' : 'Read on your device before anything is sent'}
              </Text>
            </View>
            {file ? (
              <IconButton icon="x" label="Remove file" onPress={() => setFile(null)} />
            ) : null}
          </Pressable>

          <Text className="text-center text-xs text-subtle">or paste it</Text>

          <TextInput
            value={pasted}
            onChangeText={setPasted}
            multiline
            editable={!file}
            placeholder="Paste the task description, requirements and deadline…"
            placeholderTextColor={tones.subtle}
            className={`min-h-[120px] rounded-xl border border-line px-4 py-3 text-[15px] leading-6 text-ink ${
              file ? 'bg-sand opacity-50' : 'bg-paper'
            }`}
            style={{ textAlignVertical: 'top' }}
          />

          {error ? <Notice title="Could not read that brief" body={error} /> : null}
        </>
      )}

      {draft && error ? <Notice title="Could not save" body={error} /> : null}
    </Sheet>
  );
}

/** The editable preview of what Gemini read, shown before anything is written. */
function DraftReview({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const tones = useTones();
  const due = toDate(draft.dueDate);

  return (
    <>
      <View className="gap-1.5">
        <Text className="text-sm font-medium text-muted">Title</Text>
        <TextInput
          value={draft.title}
          onChangeText={(title) => onChange({ ...draft, title })}
          className="rounded-xl border border-line bg-surface px-4 py-3 text-[15px] text-ink"
        />
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Type</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {ASSIGNMENT_KINDS.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: draft.kind === option.id }}
              onPress={() => onChange({ ...draft, kind: option.id as AssignmentKind })}
              className={`flex-row items-center gap-1.5 rounded-lg px-3 py-2 ${
                draft.kind === option.id ? 'bg-ink' : 'bg-sand'
              }`}
            >
              <Icon
                name={option.icon}
                size={13}
                color={draft.kind === option.id ? tones.inverse : subjectInk(option.color)}
              />
              <Text
                className={`text-xs font-semibold ${
                  draft.kind === option.id ? 'text-paper' : 'text-ink'
                }`}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <DatePicker
        label="Deadline"
        value={due}
        placeholder="No deadline found — set one"
        onChange={(date) =>
          onChange({ ...draft, dueDate: date ? Timestamp.fromDate(date) : null })
        }
      />
      <Text className="-mt-1 text-xs leading-4 text-subtle">
        This becomes a to-do and shows in your calendar. Check it against the brief.
      </Text>

      {draft.brief ? (
        <View className="gap-2 rounded-xl bg-paper p-4">
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">Rundown</Text>
          <Markdown source={draft.brief} />
        </View>
      ) : null}

      {draft.steps.length > 0 ? (
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Text className="text-xs font-bold uppercase tracking-wider text-muted">Plan</Text>
            <Badge label={`${draft.steps.length} steps`} />
          </View>
          {draft.steps.map((step, index) => (
            <View key={step.id} className="flex-row gap-2.5 rounded-xl bg-paper p-3">
              <Text className="text-xs font-bold text-subtle">{index + 1}</Text>
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-medium leading-5 text-ink">{step.title}</Text>
                {step.detail ? (
                  <Text className="text-xs leading-5 text-muted">{step.detail}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {draft.deliverables.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">Hand in</Text>
          {draft.deliverables.map((item) => (
            <Text key={item} className="text-sm leading-5 text-ink">
              • {item}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

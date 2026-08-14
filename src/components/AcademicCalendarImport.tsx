import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { FileDropZone } from '@/components/FileDropZone';
import { Sheet } from '@/components/Sheet';
import { Button, Notice } from '@/components/ui';
import type { ExtractedAcademicTerm, Semester } from '@/lib/schema';
import {
  analyseAcademicCalendar,
  commitAcademicCalendar,
  type CalendarImportOutcome,
} from '@/services/academicPlanner';
import type { MaterialFile } from '@/services/ingestion';

type StagedTerm = ExtractedAcademicTerm & { include: boolean };

export function AcademicCalendarImport({
  visible,
  onClose,
  uid,
  semesters,
  onImported,
}: {
  visible: boolean;
  onClose: () => void;
  uid: string;
  semesters: Semester[];
  onImported: (outcome: CalendarImportOutcome) => void;
}) {
  const [terms, setTerms] = useState<StagedTerm[]>([]);
  const [sourceName, setSourceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(files: MaterialFile[]) {
    if (files.length !== 1) throw new Error('Choose one official academic calendar at a time.');
    setBusy(true);
    setError(null);
    try {
      const extracted = await analyseAcademicCalendar(files[0]);
      if (extracted.length === 0) throw new Error('No complete academic terms were found.');
      setSourceName(files[0].name);
      setTerms(extracted.map((term) => ({ ...term, include: true })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const selected = terms.filter((term) => term.include);
      const outcome = await commitAcademicCalendar(uid, selected, semesters, sourceName);
      onImported(outcome);
      setTerms([]);
      setSourceName('');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    setError(null);
    setTerms([]);
    setSourceName('');
    onClose();
  }

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="Import academic calendar"
      icon="calendar"
      dismissOnScrim={false}
      maxHeight={600}
      footer={
        terms.length ? (
          <>
            <Button label="Cancel" variant="ghost" onPress={close} disabled={busy} />
            <View className="flex-1" />
            <Button
              label={`Anchor ${terms.filter((term) => term.include).length} term${
                terms.filter((term) => term.include).length === 1 ? '' : 's'
              }`}
              icon="check"
              loading={busy}
              disabled={!terms.some((term) => term.include)}
              onPress={() => void save()}
            />
          </>
        ) : undefined
      }
    >
      {error ? <Notice title="Could not import that calendar" body={error} /> : null}

      {terms.length === 0 ? (
        <>
          <Text className="text-sm leading-6 text-muted">
            Notomi reads the document's own term names and boundaries, including teaching weeks,
            study leave and examinations. Nothing is saved before this review.
          </Text>
          <FileDropZone
            busy={busy}
            title="Drop an official academic calendar"
            body="PDF, PNG, JPG or WEBP. The parser is institution-independent."
            onFiles={read}
          />
        </>
      ) : (
        <View className="gap-3">
          <View className="gap-1">
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
              Review extracted terms
            </Text>
            <Text className="text-xs leading-5 text-subtle">
              From {sourceName}. Select the terms that belong in Program structure.
            </Text>
          </View>

          {terms.map((term, index) => (
            <Pressable
              key={`${term.code || term.name}-${term.startDate}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: term.include }}
              onPress={() =>
                setTerms((current) =>
                  current.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, include: !entry.include } : entry
                  )
                )
              }
              className={`flex-row items-start gap-3 rounded-xl border p-4 ${
                term.include ? 'border-pine/40 bg-pine-soft' : 'border-line bg-paper'
              }`}
            >
              <View
                className={`mt-0.5 h-5 w-5 items-center justify-center rounded border ${
                  term.include ? 'border-pine bg-pine' : 'border-subtle bg-surface'
                }`}
              >
                {term.include ? <Icon name="check" size={12} color="#FFFFFF" /> : null}
              </View>
              <View className="flex-1 gap-1">
                <Text className="text-sm font-semibold text-ink">{term.name}</Text>
                <Text className="text-xs leading-5 text-muted">
                  Teaching {formatIso(term.startDate)} - {formatIso(term.teachingEndDate)} ·{' '}
                  {term.teachingWeeks} weeks
                </Text>
                {term.studyLeaveStart ? (
                  <Text className="text-xs leading-5 text-muted">
                    Study leave {formatIso(term.studyLeaveStart)} - {formatIso(term.studyLeaveEnd)}
                  </Text>
                ) : null}
                {term.examStart ? (
                  <Text className="text-xs leading-5 text-muted">
                    Exams {formatIso(term.examStart)} - {formatIso(term.examEnd)}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </Sheet>
  );
}

function formatIso(value: string | null): string {
  if (!value) return 'not stated';
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

import { useCallback, useState } from 'react';
import type { ClassBlock, RoutineBlock, Subject } from '@/lib/schema';
import { pickMaterials, type MaterialFile } from '@/services/ingestion';
import { scanTimetableFiles, type ImportOutcome, type StagedImport } from '@/services/timetable';

/**
 * The schedule importer, as state.
 *
 * The flow — pick a screenshot, read it with Gemini, stage the rows, wait for
 * the student to approve them — is the same wherever it starts, and it now
 * starts in two places: the timetable and the dashboard hero. Keeping it in a
 * hook means both entry points share one implementation, and neither owns the
 * other's copy of "scanning".
 *
 * Nothing here writes to Firestore. Everything the scan produces is held in
 * `staged` until ImportReview commits it, which is what makes the verification
 * step real rather than decorative.
 */
export function useScheduleImport(
  subjects: Subject[],
  classes: ClassBlock[] = [],
  routines: RoutineBlock[] = []
) {
  const [scanning, setScanning] = useState(false);
  const [staged, setStaged] = useState<StagedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scanFiles = useCallback(
    async (picked: MaterialFile[]) => {
      setError(null);
      setNotice(null);
      if (picked.length === 0) return;

      setScanning(true);
      try {
        setStaged(await scanTimetableFiles(picked, subjects, classes, routines));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setScanning(false);
      }
    },
    [subjects, classes, routines]
  );

  const scan = useCallback(async () => {
    try {
      await scanFiles(await pickMaterials());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [scanFiles]);

  /** The line shown after a commit, naming what the single upload created. */
  const describe = useCallback((outcome: ImportOutcome) => {
    const subjectCount = outcome.subjectsCreated + outcome.subjectsReused;
    setStaged(null);
    setNotice(
      `Imported ${outcome.classesAdded} class${outcome.classesAdded === 1 ? '' : 'es'} across ` +
        `${subjectCount} subject${subjectCount === 1 ? '' : 's'}` +
        (outcome.subjectsCreated > 0
          ? ` — ${outcome.subjectsCreated} new library folder${
              outcome.subjectsCreated === 1 ? '' : 's'
            } created and filed into your program.`
          : '.')
    );
  }, []);

  return {
    scan,
    scanFiles,
    scanning,
    staged,
    setStaged,
    error,
    setError,
    notice,
    setNotice,
    describe,
  };
}

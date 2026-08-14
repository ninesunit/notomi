import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import {
  ingestFiles,
  pickMaterials,
  validateMaterialBatch,
  type IngestProgress,
  type IngestResult,
  type MaterialFile,
} from '@/services/ingestion';
import { StagingModal } from '@/components/StagingModal';
import { useAuth } from './useAuth';
import type { StagedImport } from '@/services/timetable';

export type IngestSummary = {
  tone: 'pine' | 'amber' | 'rose';
  title: string;
  body?: string;
};

type IngestValue = {
  progress: IngestProgress | null;
  busy: boolean;
  summary: IngestSummary | null;
  start: (subjectId?: string) => Promise<IngestResult[]>;
  startFiles: (files: MaterialFile[], subjectId?: string) => Promise<IngestResult[]>;
  dismiss: () => void;
  scheduleReview: StagedImport | null;
  clearScheduleReview: () => void;
};

const IngestContext = createContext<IngestValue | null>(null);

function mergeScheduleImports(imports: StagedImport[]): StagedImport {
  const seen = new Set<string>();
  const rows = imports.flatMap((entry, batchIndex) =>
    entry.rows.flatMap((row) => {
      const key = [row.code, row.title, row.section, row.day, row.start, row.end]
        .join('|')
        .toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...row, id: `batch-${batchIndex}-${row.id}` }];
    })
  );
  return {
    rows,
    skipped: imports.reduce((total, entry) => total + entry.skipped, 0),
    sourceFiles: [...new Set(imports.flatMap((entry) => entry.sourceFiles))],
  };
}

/**
 * Ingest state lives above the screens because the button that starts an
 * upload is often destroyed by its own success: the "Upload your first
 * document" button sits inside an empty state that disappears the moment the
 * first subject arrives. Holding progress and the result banner in the
 * workspace shell means the confirmation survives that re-render.
 */
export function IngestProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [summary, setSummary] = useState<IngestSummary | null>(null);
  const [staged, setStaged] = useState<MaterialFile[]>([]);
  const [stagingError, setStagingError] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState<string | undefined>();
  const [processing, setProcessing] = useState(false);
  const [scheduleReview, setScheduleReview] = useState<StagedImport | null>(null);

  const run = useCallback(
    async (files: MaterialFile[], subjectId?: string) => {
      if (!user) return [];
      setSummary(null);

      try {
        if (files.length === 0) return [];
        const { results, errors } = await ingestFiles(files, {
          uid: user.uid,
          subjectId,
          onProgress: setProgress,
        });

        if (results.length === 0 && errors.length === 0) return []; // Cancelled.

        const deadlines = results.reduce((total, result) => total + result.deadlinesCreated, 0);
        const warnings = results.filter((result) => result.warning);
        const detail = [
          ...warnings.map((warning) => `${warning.fileName}: ${warning.warning}`),
          ...errors.map((error) => `${error.fileName}: ${error.message}`),
        ].join('\n');

        if (results.length > 0) {
          const documents = results.filter(
            (result) => result.route !== 'TimetableSchedule' && result.route !== 'AcademicCalendar'
          ).length;
          const schedules = results.filter((result) => result.route === 'TimetableSchedule').length;
          const calendars = results.filter((result) => result.route === 'AcademicCalendar').length;
          const parts = [`Processed ${results.length} file${results.length === 1 ? '' : 's'}`];
          if (documents > 0) parts.push(`${documents} added to Knowledge`);
          if (schedules > 0) parts.push(`${schedules} schedule${schedules === 1 ? '' : 's'} ready for review`);
          if (calendars > 0) parts.push(`${calendars} academic calendar${calendars === 1 ? '' : 's'} anchored`);
          if (deadlines > 0) {
            parts.push(`${deadlines} deadline${deadlines === 1 ? '' : 's'} added to your to-dos`);
          }
          setSummary({
            tone: errors.length || warnings.length ? 'amber' : 'pine',
            title: parts.join(' · '),
            body: detail || undefined,
          });
        } else {
          setSummary({
            tone: 'rose',
            title: 'Nothing could be imported',
            body: detail,
          });
        }

        const scheduleImports = results.flatMap((result) =>
          result.stagedSchedule ? [result.stagedSchedule] : []
        );
        if (scheduleImports.length > 0) {
          setScheduleReview(mergeScheduleImports(scheduleImports));
          router.replace('/schedule?view=review' as never);
        }

        return results;
      } catch (error) {
        setSummary({
          tone: 'rose',
          title: 'Upload failed',
          body: error instanceof Error ? error.message : String(error),
        });
        return [];
      } finally {
        setProgress(null);
      }
    },
    [user, router]
  );

  const start = useCallback(
    async (subjectId?: string) => {
      try {
        const picked = await pickMaterials();
        if (picked.length === 0) return [];
        validateMaterialBatch(picked);
        setSubjectId(subjectId);
        setStaged(picked);
        setStagingError(null);
        return [];
      } catch (error) {
        setSummary({
          tone: 'rose',
          title: 'Upload failed',
          body: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
    []
  );

  const stageFiles = useCallback(async (files: MaterialFile[], targetSubjectId?: string) => {
    if (files.length === 0) return [];
    try {
      validateMaterialBatch(files);
      setSubjectId(targetSubjectId);
      setStaged(files);
      setStagingError(null);
    } catch (error) {
      setStagingError(error instanceof Error ? error.message : String(error));
    }
    return [];
  }, []);

  const addMore = useCallback(async () => {
    try {
      const picked = await pickMaterials();
      if (picked.length === 0) return;
      const next = [...staged, ...picked];
      validateMaterialBatch(next);
      setStaged(next);
      setStagingError(null);
    } catch (error) {
      setStagingError(error instanceof Error ? error.message : String(error));
    }
  }, [staged]);

  const processStaged = useCallback(async () => {
    const files = staged;
    if (files.length === 0 || processing) return;
    setProcessing(true);
    try {
      await run(files, subjectId);
      setStaged([]);
      setSubjectId(undefined);
    } finally {
      setProcessing(false);
    }
  }, [run, staged, subjectId, processing]);

  const value = useMemo<IngestValue>(
    () => ({
      progress,
      busy: processing || (progress !== null && progress.stage !== 'done'),
      summary,
      start,
      startFiles: stageFiles,
      dismiss: () => setSummary(null),
      scheduleReview,
      clearScheduleReview: () => setScheduleReview(null),
    }),
    [progress, processing, summary, start, stageFiles, scheduleReview]
  );

  return (
    <IngestContext.Provider value={value}>
      {children}
      <StagingModal
        files={staged}
        progress={progress}
        busy={processing || (progress !== null && progress.stage !== 'done')}
        error={stagingError}
        onClose={() => {
          if (processing || progress) return;
          setStaged([]);
          setSubjectId(undefined);
          setStagingError(null);
        }}
        onRemove={(index) => setStaged((current) => current.filter((_, item) => item !== index))}
        onAdd={() => void addMore()}
        onProcess={() => void processStaged()}
      />
    </IngestContext.Provider>
  );
}

export function useIngest(): IngestValue {
  const context = useContext(IngestContext);
  if (!context) throw new Error('useIngest must be used inside <IngestProvider>');
  return context;
}

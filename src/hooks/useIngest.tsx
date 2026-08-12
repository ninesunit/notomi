import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  ingestFiles,
  pickMaterials,
  type IngestProgress,
  type IngestResult,
  type MaterialFile,
} from '@/services/ingestion';
import { useAuth } from './useAuth';

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
};

const IngestContext = createContext<IngestValue | null>(null);

/**
 * Ingest state lives above the screens because the button that starts an
 * upload is often destroyed by its own success: the "Upload your first
 * document" button sits inside an empty state that disappears the moment the
 * first subject arrives. Holding progress and the result banner in the
 * workspace shell means the confirmation survives that re-render.
 */
export function IngestProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [summary, setSummary] = useState<IngestSummary | null>(null);

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
          const parts = [`Added ${results.length} document${results.length === 1 ? '' : 's'}`];
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
    [user]
  );

  const start = useCallback(
    async (subjectId?: string) => {
      try {
        return await run(await pickMaterials(), subjectId);
      } catch (error) {
        setSummary({
          tone: 'rose',
          title: 'Upload failed',
          body: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
    [run]
  );

  const value = useMemo<IngestValue>(
    () => ({
      progress,
      busy: progress !== null && progress.stage !== 'done',
      summary,
      start,
      startFiles: run,
      dismiss: () => setSummary(null),
    }),
    [progress, summary, start, run]
  );

  return <IngestContext.Provider value={value}>{children}</IngestContext.Provider>;
}

export function useIngest(): IngestValue {
  const context = useContext(IngestContext);
  if (!context) throw new Error('useIngest must be used inside <IngestProvider>');
  return context;
}

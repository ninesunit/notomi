import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Sheet } from './Sheet';
import { Button, Notice } from './ui';
import { useUid } from '@/hooks/useAuth';
import {
  checkUploadSize,
  describeIngestError,
  pickMaterials,
  processUploadedMaterial,
  stageLabel,
  STAGE_ORDER,
  type IngestStage,
  type MaterialFile,
} from '@/services/ingestion';
import { classify, humanSize } from '@/services/fileProcessor';
import { isR2Configured, r2ConfigHint } from '@/services/r2Storage';
import type { FileKind } from '@/lib/schema';

type FileState = {
  file: MaterialFile;
  stage: IngestStage | null;
  kind: FileKind | null;
  status: 'queued' | 'working' | 'done' | 'failed';
  message?: string;
  deadlines?: number;
};

const KIND_ICON: Record<FileKind, 'file-text' | 'image' | 'film' | 'mic' | 'monitor'> = {
  pdf: 'file-text',
  docx: 'file-text',
  text: 'file-text',
  pptx: 'monitor',
  image: 'image',
  video: 'film',
  audio: 'mic',
};

/**
 * "Add material" flow for a subject folder. Shows what the pipeline is doing
 * per file — parsing happens on the device and can take a few seconds on a
 * large PDF, so a silent spinner would read as a hang.
 */
export function AddMaterialModal({
  subjectId,
  subjectName,
  visible,
  onClose,
}: {
  subjectId: string;
  subjectName: string;
  visible: boolean;
  onClose: () => void;
}) {
  const uid = useUid();
  const [files, setFiles] = useState<FileState[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setFiles([]);
      setError(null);
    }
  }, [visible]);

  const choose = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickMaterials();
      if (picked.length === 0) return;

      // Oversized files are rejected here rather than mid-upload, so the
      // student can swap them out before starting a long batch.
      setFiles(
        picked.map((file) => {
          const kind = classify(file.name, file.mimeType ?? '');
          const entry: FileState = {
            file,
            stage: null,
            kind: kind === 'unknown' ? null : kind,
            status: 'queued',
          };
          try {
            checkUploadSize(file);
          } catch (caught) {
            return { ...entry, status: 'failed', message: describeIngestError(caught) };
          }
          return entry;
        })
      );
    } catch (caught) {
      setError(describeIngestError(caught));
    }
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);

    for (let index = 0; index < files.length; index += 1) {
      const update = (patch: Partial<FileState>) =>
        setFiles((previous) =>
          previous.map((entry, i) => (i === index ? { ...entry, ...patch } : entry))
        );

      // Already rejected at pick time (oversized or unsupported).
      if (files[index].status === 'failed') continue;

      update({ status: 'working' });
      try {
        const result = await processUploadedMaterial(
          files[index].file,
          subjectId,
          uid,
          (stage, kind) => update(kind ? { stage, kind } : { stage })
        );
        update({
          status: 'done',
          stage: 'done',
          message: result.warning,
          deadlines: result.deadlinesCreated,
        });
      } catch (caught) {
        update({ status: 'failed', message: describeIngestError(caught) });
      }
    }

    setRunning(false);
  }, [files, subjectId, uid]);

  const allDone = files.length > 0 && files.every((f) => f.status === 'done' || f.status === 'failed');
  const succeeded = files.filter((f) => f.status === 'done').length;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={`Add material to ${subjectName}`}
      icon="upload-cloud"
      footer={
        files.length > 0 ? (
          <>
            <Text className="flex-1 text-xs text-muted">
              {allDone
                ? `${succeeded} of ${files.length} added`
                : running
                  ? 'Working — keep this open'
                  : `${files.length} file${files.length === 1 ? '' : 's'} ready`}
            </Text>

            {allDone ? (
              <Button label="Done" onPress={onClose} size="sm" />
            ) : (
              <>
                <Button
                  label="Change"
                  variant="ghost"
                  size="sm"
                  disabled={running}
                  onPress={() => void choose()}
                />
                <Button
                  label="Upload"
                  icon="upload"
                  size="sm"
                  loading={running}
                  disabled={running}
                  onPress={() => void run()}
                />
              </>
            )}
          </>
        ) : undefined
      }
    >
            {!isR2Configured() ? (
              <Notice
                tone="amber"
                title="Original files will not be stored"
                body={r2ConfigHint()}
              />
            ) : null}

            {error ? <Notice title="Could not read that file" body={error} /> : null}

            {files.length === 0 ? (
              <View className="items-center gap-4 rounded-xl border border-dashed border-line px-6 py-10">
                <Feather name="file-plus" size={22} color="#9A9488" />
                <Text className="text-center text-sm leading-5 text-muted">
                  Choose PDFs, Word docs, slide decks, notes, photos of a whiteboard, or a lecture
                  recording. Notomi reads the text out of all of them and files it under this
                  subject.
                </Text>
                <Button label="Choose files" icon="folder" variant="secondary" onPress={() => void choose()} />
              </View>
            ) : (
              <View className="gap-3">
                {files.map((entry, index) => (
                  <FileRow key={`${entry.file.name}-${index}`} entry={entry} />
                ))}
              </View>
            )}
    </Sheet>
  );
}

function FileRow({ entry }: { entry: FileState }) {
  const stageIndex = entry.stage ? STAGE_ORDER.indexOf(entry.stage) : -1;
  const progress =
    entry.status === 'done'
      ? 1
      : stageIndex >= 0
        ? (stageIndex + 1) / (STAGE_ORDER.length + 1)
        : 0;

  const tint =
    entry.status === 'failed' ? 'bg-rose' : entry.status === 'done' ? 'bg-pine' : 'bg-accent';

  return (
    <View className="gap-2 rounded-xl border border-line p-3.5">
      <View className="flex-row items-center gap-3">
        <Feather
          name={
            entry.status === 'done'
              ? 'check-circle'
              : entry.status === 'failed'
                ? 'alert-circle'
                : entry.kind
                  ? KIND_ICON[entry.kind]
                  : 'file-text'
          }
          size={15}
          color={entry.status === 'done' ? '#2E6F5E' : entry.status === 'failed' ? '#B0443E' : '#6F6A5F'}
        />
        <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
          {entry.file.name}
        </Text>
        {entry.deadlines ? (
          <Text className="text-xs font-medium text-pine">
            +{entry.deadlines} deadline{entry.deadlines === 1 ? '' : 's'}
          </Text>
        ) : entry.file.size ? (
          <Text className="text-xs text-subtle">{humanSize(entry.file.size)}</Text>
        ) : null}
      </View>

      <View className="h-1 w-full overflow-hidden rounded-full bg-sand">
        <View className={`h-full rounded-full ${tint}`} style={{ width: `${progress * 100}%` }} />
      </View>

      <Text
        className={`text-xs ${entry.status === 'failed' ? 'text-rose' : 'text-muted'}`}
        numberOfLines={3}
      >
        {entry.status === 'failed'
          ? entry.message
          : entry.status === 'done'
            ? entry.message ?? 'Added to your library'
            : entry.stage
              ? stageLabel(entry.stage, entry.kind)
              : 'Ready to upload'}
      </Text>
    </View>
  );
}

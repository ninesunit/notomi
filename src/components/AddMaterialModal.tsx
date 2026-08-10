import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Button, Notice } from './ui';
import { useUid } from '@/hooks/useAuth';
import {
  describeIngestError,
  pickMaterials,
  processUploadedMaterial,
  STAGE_LABELS,
  STAGE_ORDER,
  type IngestStage,
  type MaterialFile,
} from '@/services/ingestion';
import { isR2Configured, r2ConfigHint } from '@/services/r2Storage';

type FileState = {
  file: MaterialFile;
  stage: IngestStage | null;
  status: 'queued' | 'working' | 'done' | 'failed';
  message?: string;
  deadlines?: number;
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
      setFiles(picked.map((file) => ({ file, stage: null, status: 'queued' })));
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

      update({ status: 'working' });
      try {
        const result = await processUploadedMaterial(
          files[index].file,
          subjectId,
          uid,
          (stage) => update({ stage })
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Scrim is a normal flex parent, so the sheet is centred without any
          absolutely positioned layer that could escape the viewport. */}
      <View className="flex-1 items-center justify-center bg-ink/40 px-5">
        <View className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface">
          <View className="flex-row items-center gap-3 border-b border-line px-5 py-4">
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
              <Feather name="upload-cloud" size={16} color="#B4552D" />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px] font-semibold text-ink">Add material</Text>
              <Text className="text-xs text-muted" numberOfLines={1}>
                to {subjectName}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              disabled={running}
              className="h-8 w-8 items-center justify-center rounded-lg"
            >
              <Feather name="x" size={16} color="#6F6A5F" />
            </Pressable>
          </View>

          <ScrollView className="max-h-[420px]" contentContainerClassName="gap-4 p-5">
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
                  Choose PDF, DOCX, TXT or Markdown files. Notomi reads them on your device, stores
                  the original in Cloudflare R2, and asks Gemini for a summary and any deadlines.
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
          </ScrollView>

          {files.length > 0 ? (
            <View className="flex-row items-center justify-between gap-3 border-t border-line px-5 py-4">
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
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
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
              ? STAGE_LABELS[entry.stage]
              : 'Ready to upload'}
      </Text>
    </View>
  );
}

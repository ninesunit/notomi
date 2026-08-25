import { ActivityIndicator, Text, View } from 'react-native';
import { Icon, useTones } from './Icon';
import { Sheet } from './Sheet';
import { Button, IconButton, Notice } from './ui';
import { classify, humanSize } from '@/services/fileProcessor';
import {
  stageLabel,
  STAGE_ORDER,
  type IngestProgress,
  type MaterialFile,
} from '@/services/ingestion';

function typeLabel(file: MaterialFile): string {
  const name = file.name.toLowerCase();
  if (/academic[-_ ]?calendar|term[-_ ]?dates|semester[-_ ]?dates/.test(name)) return 'Academic calendar';
  if (/timetable|class[-_ ]?schedule|weekly[-_ ]?schedule/.test(name)) return 'Schedule';
  if (/syllabus|course[-_ ]?outline|lecture|slides?/.test(name)) return 'Subject material';
  const kind = classify(file.name, file.mimeType ?? '');
  if (kind === 'pptx') return 'Slide deck · AI classify';
  if (kind === 'docx') return 'Document · AI classify';
  if (kind === 'image') return 'Image · AI classify';
  if (kind === 'pdf') return 'PDF · AI classify';
  if (kind === 'audio') return 'Audio · AI classify';
  if (kind === 'video') return 'Video · AI classify';
  return kind === 'unknown' ? 'AI classify' : 'Text · AI classify';
}

export function StagingModal({
  files,
  progress,
  busy,
  error,
  onClose,
  onRemove,
  onAdd,
  onProcess,
}: {
  files: MaterialFile[];
  progress: IngestProgress | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onProcess: () => void;
}) {
  const tones = useTones();
  const total = files.reduce((sum, file) => sum + (file.size ?? file.file?.size ?? 0), 0);
  const stageIndex = progress ? STAGE_ORDER.indexOf(progress.stage) : -1;
  const stageProgress = stageIndex < 0 ? 0.06 : (stageIndex + 1) / STAGE_ORDER.length;
  return (
    <Sheet
      visible={files.length > 0}
      onClose={onClose}
      title="Staging queue"
      icon="layers"
      dismissOnScrim={!busy}
      maxHeight={680}
      footer={
        <>
          <Button
            label="Add more files"
            icon="plus"
            variant="ghost"
            size="sm"
            disabled={busy || files.length >= 10}
            onPress={onAdd}
          />
          <View className="flex-1" />
          <Button
            label="Process & Upload All"
            icon="upload-cloud"
            size="sm"
            loading={busy}
            disabled={busy || files.length === 0}
            onPress={onProcess}
          />
        </>
      }
    >
      <View className="gap-1">
        <Text className="text-sm leading-5 text-muted">
          Review the batch before anything is analysed or saved. Notomi will classify and route each file automatically.
        </Text>
        <Text className="text-xs font-semibold text-subtle">
          {files.length} of 10 files · {humanSize(total)} of 25 MB
        </Text>
      </View>

      {error ? <Notice title="The batch could not be staged" body={error} /> : null}

      {busy ? (
        <View accessibilityLiveRegion="polite" className="gap-2 rounded-xl bg-accent-soft/60 p-3.5">
          <View className="flex-row items-center gap-3">
            <ActivityIndicator size="small" color={tones.accent} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-accent">
                {progress ? stageLabel(progress.stage, progress.kind) : 'Preparing your files…'}
              </Text>
              <Text className="text-xs text-muted" numberOfLines={1}>
                {progress
                  ? `${progress.fileName} · ${progress.index} of ${progress.total}`
                  : 'Nothing has been saved yet.'}
              </Text>
            </View>
          </View>
          <View className="h-1 overflow-hidden rounded-full bg-surface">
            <View
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round(stageProgress * 100)}%` }}
            />
          </View>
        </View>
      ) : null}

      <View className="gap-2">
        {files.map((file, index) => {
          const active = progress?.index === index + 1;
          return (
            <View
              key={`${file.name}-${file.size ?? 0}-${index}`}
              className={`flex-row items-center gap-3 rounded-xl border px-3 py-3 ${
                active ? 'border-accent bg-accent-soft/30' : 'border-line bg-surface'
              }`}
            >
              <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
                <Icon name="file-text" size={15} tone="muted" />
              </View>
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                  {file.name}
                </Text>
                <View className="flex-row items-center gap-2">
                  <View className="rounded-full bg-sand px-2 py-0.5">
                    <Text className="text-[10px] font-semibold text-muted">{typeLabel(file)}</Text>
                  </View>
                  <Text className="text-[11px] text-subtle">
                    {humanSize(file.size ?? file.file?.size ?? 0)}
                  </Text>
                  {active ? (
                    <Text className="text-[11px] font-medium text-accent">
                      {stageLabel(progress.stage, progress.kind)}
                    </Text>
                  ) : null}
                </View>
              </View>
              <IconButton
                icon="x"
                label={`Remove ${file.name}`}
                onPress={() => {
                  if (!busy) onRemove(index);
                }}
              />
            </View>
          );
        })}
      </View>
    </Sheet>
  );
}

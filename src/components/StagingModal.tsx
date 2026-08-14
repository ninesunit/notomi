import { Text, View } from 'react-native';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Button, IconButton, Notice } from './ui';
import { classify, humanSize } from '@/services/fileProcessor';
import type { IngestProgress, MaterialFile } from '@/services/ingestion';

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
  const total = files.reduce((sum, file) => sum + (file.size ?? file.file?.size ?? 0), 0);
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
                <Icon name="file-text" size={15} color="#6F6A5F" />
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
                      {progress.fileName ? `Processing ${progress.index} of ${progress.total}` : 'Processing'}
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

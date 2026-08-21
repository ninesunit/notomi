import { useState, type DragEvent } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import {
  materialFilesFromWeb,
  capturePhotoFromWeb,
  pickMaterials,
  validateMaterialBatch,
  type MaterialFile,
} from '@/services/ingestion';

export function FileDropZone({
  onFiles,
  busy = false,
  title = 'Drop files here',
  body = 'PDF, PNG, JPG, PPTX or ICS. Up to 10 files and 25 MB total.',
  compact = false,
}: {
  onFiles: (files: MaterialFile[]) => void | Promise<void>;
  busy?: boolean;
  title?: string;
  body?: string;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept(files: MaterialFile[]) {
    setError(null);
    try {
      validateMaterialBatch(files);
      await onFiles(files);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const webDropProps =
    Platform.OS === 'web'
      ? {
          onDragEnter: (event: DragEvent) => {
            event.preventDefault();
            setDragging(true);
          },
          onDragOver: (event: DragEvent) => event.preventDefault(),
          onDragLeave: (event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) {
              void accept(materialFilesFromWeb(event.dataTransfer.files));
            }
          },
        }
      : {};

  return (
    <View className="gap-2">
      <View
        {...webDropProps}
        className={`items-center rounded-2xl border border-dashed px-6 ${compact ? 'gap-2 py-4' : 'gap-3 py-8'} ${
          dragging ? 'border-accent bg-accent-soft' : 'border-line bg-paper'
        }`}
      >
        <Icon name="upload-cloud" size={compact ? 18 : 22} tone={dragging ? 'accent' : 'subtle'} />
        <View className="items-center gap-1">
          <Text className="text-sm font-semibold text-ink">{title}</Text>
          <Text className="text-center text-xs leading-5 text-muted">{body}</Text>
        </View>
        <View className="flex-row flex-wrap items-center justify-center gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              void pickMaterials()
                .then(accept)
                .catch((caught) => setError(String(caught)))
            }
            className={`rounded-lg bg-ink px-4 py-2 ${busy ? 'opacity-50' : ''}`}
          >
            <Text className="text-xs font-semibold text-paper">
              {busy ? 'Working…' : 'Choose files'}
            </Text>
          </Pressable>
          {Platform.OS === 'web' ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                void capturePhotoFromWeb()
                  .then(accept)
                  .catch((caught) => setError(String(caught)))
              }
              className={`flex-row items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 ${busy ? 'opacity-50' : ''}`}
            >
              <Icon name="camera" size={13} tone="ink" />
              <Text className="text-xs font-semibold text-ink">Take photo</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {error ? <Text className="text-xs leading-5 text-rose">{error}</Text> : null}
    </View>
  );
}

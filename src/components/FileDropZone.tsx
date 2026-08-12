import { useState, type DragEvent } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  materialFilesFromWeb,
  pickMaterials,
  validateMaterialBatch,
  type MaterialFile,
} from '@/services/ingestion';

export function FileDropZone({
  onFiles,
  busy = false,
  title = 'Drop files here',
  body = 'PDF, PNG, JPG or PPTX. Up to 10 files and 25 MB total.',
}: {
  onFiles: (files: MaterialFile[]) => void | Promise<void>;
  busy?: boolean;
  title?: string;
  body?: string;
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
        className={`items-center gap-3 rounded-xl border border-dashed px-6 py-8 ${
          dragging ? 'border-accent bg-accent-soft' : 'border-line bg-paper'
        }`}
      >
        <Feather name="upload-cloud" size={22} color={dragging ? '#B4552D' : '#9A9488'} />
        <View className="items-center gap-1">
          <Text className="text-sm font-semibold text-ink">{title}</Text>
          <Text className="text-center text-xs leading-5 text-muted">{body}</Text>
        </View>
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
      </View>
      {error ? <Text className="text-xs leading-5 text-rose">{error}</Text> : null}
    </View>
  );
}

import { Text, View } from 'react-native';
import { Button } from './ui';
import { useIngest } from '@/hooks/useIngest';
import { STAGE_LABELS, type IngestResult } from '@/lib/ingest';

type Props = {
  /** Pin every upload to one subject (used inside a subject folder). */
  subjectId?: string;
  label?: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
  onComplete?: (results: IngestResult[]) => void;
};

/**
 * Trigger for Task 2's pipeline. Everything up to the Firestore write happens
 * on the device: the file is parsed locally, then only the extracted text (for
 * Gemini) and the original bytes (for Storage) leave the client.
 *
 * Progress and the result banner are owned by IngestProvider so they outlive
 * this button — it is frequently unmounted by its own success.
 */
export function UploadButton({
  subjectId,
  label = 'Upload material',
  variant = 'primary',
  size = 'md',
  onComplete,
}: Props) {
  const { start, busy, progress } = useIngest();

  return (
    <View className="gap-2">
      <Button
        label={busy ? 'Working…' : label}
        icon="upload"
        variant={variant}
        size={size}
        loading={busy}
        onPress={() => void start(subjectId).then((results) => onComplete?.(results))}
        className="self-start"
      />

      {busy && progress ? (
        <View className="gap-0.5">
          <Text className="text-xs font-medium text-muted">
            {STAGE_LABELS[progress.stage]}
            {progress.total > 1 ? ` (${progress.index}/${progress.total})` : ''}
          </Text>
          {progress.fileName ? (
            <Text className="text-xs text-subtle" numberOfLines={1}>
              {progress.fileName}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

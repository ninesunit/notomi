import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { feedback } from '@/lib/sound';
import { isDriveConfigured } from '@/lib/driveUtils';

/**
 * Drop a file anywhere on the screen and it goes to Drive.
 *
 * Two details make this behave rather than merely work. The browser's default
 * for a dropped PDF is to navigate away and open it, losing whatever the
 * student was doing — so the default is cancelled on the window, not just on
 * this element. And dragenter/dragleave fire for every child element the
 * pointer crosses, which makes a naive implementation flicker; a depth counter
 * is what keeps the overlay steady while the pointer moves across the canvas.
 *
 * Renders nothing at all on native or when Drive is not set up, so it can be
 * mounted unconditionally by screens that do not want to think about either.
 */
export function DriveDropZone({
  onFiles,
  label = 'Drop files to add them to your Drive',
  disabled = false,
}: {
  onFiles: (files: File[]) => void | Promise<void>;
  label?: string;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setOver(false);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || disabled) return;

    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      if (depth.current === 1) setOver(true);
    };

    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the drop never fires and the browser opens the file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };

    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      reset();

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      feedback('sent');
      void onFiles(files);
    };

    // Cancelling on the window matters: a drop that lands outside this element
    // would otherwise still navigate the tab away to the file.
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [disabled, onFiles, reset]);

  if (Platform.OS !== 'web' || disabled || !isDriveConfigured() || !over) return null;

  return (
    <View
      // Never intercept the pointer: the drop is handled on the window, and a
      // hit-testable overlay would swallow the event it exists to announce.
      pointerEvents="none"
      className="absolute inset-0 z-50 items-center justify-center p-8"
      style={{ backgroundColor: 'rgba(27,26,23,0.45)' }}
    >
      <View className="items-center gap-3 rounded-3xl border-2 border-dashed border-paper bg-ink/80 px-8 py-7">
        <Icon name="upload-cloud" size={26} tone="inverse" />
        <Text className="text-center text-base font-semibold text-paper">{label}</Text>
        <Text className="text-center text-xs text-paper/70">
          PDFs, images and slides go straight into your Notomi Workspace
        </Text>
      </View>
    </View>
  );
}

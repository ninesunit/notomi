import { Suspense, lazy, type ComponentType } from 'react';
import { View } from 'react-native';

import { Loading } from '@/components/ui';

/**
 * A screen that is not in the first bundle.
 *
 * Everything the app can reach ships in one entry chunk, and that chunk is
 * what a student downloads before anything appears. Notes, the reader, the
 * arena and the migration flow are large, and none of them is where anyone
 * lands — so they are fetched when they are opened instead.
 *
 * The named-export dance is because almost nothing here has a default export,
 * and `lazy` insists on one.
 */
export function lazyScreen<Props extends object>(
  load: () => Promise<Record<string, unknown>>,
  name: string,
  label: string
): ComponentType<Props> {
  const Loaded = lazy(async () => ({
    default: (await load())[name] as ComponentType<Props>,
  }));

  return function LazyScreen(props: Props) {
    return (
      <Suspense
        fallback={
          <View className="min-h-0 flex-1 items-center justify-center bg-paper">
            <Loading label={label} />
          </View>
        }
      >
        <Loaded {...props} />
      </Suspense>
    );
  };
}

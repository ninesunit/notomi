import { router, useRouter } from 'expo-router';
import { Button } from './ui';

/**
 * The way back out of a pushed screen.
 *
 * `href` is a destination, not a command: it is where this screen sits in the
 * hierarchy, used when there is nothing to go back to. When there *is* history
 * — the usual case, because the student tapped their way in — this pops it, so
 * returning from a subject lands on the list they came from with its scroll and
 * filters intact rather than on a freshly mounted one.
 *
 * This matters most where it is least visible. Installed to an iPhone home
 * screen the app runs with no browser chrome at all: no back button, no address
 * bar. A pushed screen without one of these is a room with no door, and until
 * now the subject and document screens were exactly that.
 */
export function SurfaceBack({ href, label = 'Back' }: { href: string; label?: string }) {
  const navigation = useRouter();

  return (
    <Button
      label={label}
      icon="arrow-left"
      variant="ghost"
      size="sm"
      onPress={() => {
        if (navigation.canGoBack()) navigation.back();
        else router.replace(href as never);
      }}
    />
  );
}

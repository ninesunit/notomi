import { Redirect } from 'expo-router';

/**
 * Notomi Reel used to live here.
 *
 * The feed is gone — the cards it produced are now a Review Deck a student
 * opens on purpose, inside Knowledge, next to the material they came from.
 * This route stays behind as a redirect so a bookmark, a home-screen shortcut
 * or a shared link saved while Reel existed lands somewhere useful instead of
 * on a blank screen.
 */
export default function ReelRedirect() {
  return <Redirect href="/knowledge?view=review" />;
}

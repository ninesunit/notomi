import { Redirect } from 'expo-router';

/**
 * The feed is gone; the cards are not.
 *
 * Kept as a redirect rather than deleted so a bookmark, a home-screen shortcut
 * or a shared link from when this was a surface still lands somewhere real.
 * `?view=review` rather than `?tab=` because that is the address the removal
 * was specified against; the hub accepts both.
 */
export default function ReelRedirect() {
  return <Redirect href={'/knowledge?view=review' as never} />;
}

import { createPreference } from '@/lib/preference';
import { AMBIENT, type AmbientId } from '@/lib/ambient';

const IDS = new Set(AMBIENT.map((entry) => entry.id));

/**
 * Which soundscape, remembered across sessions.
 *
 * Validated on read rather than trusted: the stored value outlives the list,
 * and a preset removed in a later version must fall back rather than start
 * nothing and look broken.
 */
export const ambientChoice = createPreference<AmbientId>({
  key: 'notomi:ambient',
  fallback: 'brown',
  parse: (raw) =>
    typeof raw === 'string' && IDS.has(raw as AmbientId) ? (raw as AmbientId) : null,
});

export const useAmbientChoice = ambientChoice.use;

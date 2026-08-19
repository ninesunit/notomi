import type { ClassBlock } from '@/lib/schema';

/**
 * Assigns overlapping classes to side-by-side lanes.
 *
 * Two classes at the same hour cannot share the same column space, so each
 * gets a lane and the column is divided between them. Shared by the desktop
 * grid and the phone one: a week that reads as two overlapping blocks on a
 * laptop must read as two overlapping blocks on a phone, and duplicating this
 * is how those two quietly drift apart.
 */
export function laneOut<T extends ClassBlock>(
  blocks: T[]
): { block: T; lane: number; lanes: number }[] {
  const ordered = [...blocks].sort(
    (a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute
  );

  // The end time currently occupying each lane.
  const ends: number[] = [];
  const placed = ordered.map((block) => {
    let lane = ends.findIndex((end) => end <= block.startMinute);
    if (lane === -1) {
      lane = ends.length;
      ends.push(block.endMinute);
    } else {
      ends[lane] = block.endMinute;
    }
    return { block, lane };
  });

  // One width for the whole day: columns that changed width partway down read
  // as a rendering fault rather than as a busier morning.
  const lanes = Math.max(1, ends.length);
  return placed.map((entry) => ({ ...entry, lanes }));
}

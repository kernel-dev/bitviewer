// A whole workspace as undo keeps it: each value's JSON text, in chunks.
//
// Steps share what didn't change. A value's text is only made again when the
// value changes, so an unchanged value is the same string in every step, and
// a chunk whose values are all unchanged is the same array. One edit in a
// workspace of 90,000 values then costs a few kilobytes, not a full copy.

/** Values per chunk: small enough that one edit copies little, large enough
 *  that the list of chunks stays short. */
const CHUNK = 256;

export interface WorkspaceSnapshot {
  /** Each value's JSON text, CHUNK at a time. */
  readonly chunks: readonly (readonly string[])[];
  readonly length: number;
  /** The peripheral blocks as JSON text. */
  readonly peripherals: string;
}

const sameChunk = (first: readonly string[], second: readonly string[]) =>
  first === second ||
  (first.length === second.length &&
    first.every((text, index) => text === second[index]));

/** A snapshot of `texts`, reusing the chunks of `previous` that are the same. */
export function makeSnapshot(
  texts: readonly string[],
  peripherals: string,
  previous: WorkspaceSnapshot | null = null,
): WorkspaceSnapshot {
  const chunks: (readonly string[])[] = [];

  for (let start = 0; start < texts.length; start += CHUNK) {
    const chunk = texts.slice(start, start + CHUNK);
    const old = previous?.chunks[chunks.length];
    chunks.push(old && sameChunk(old, chunk) ? old : chunk);
  }

  return {
    chunks,
    length: texts.length,
    peripherals:
      previous && previous.peripherals === peripherals
        ? previous.peripherals
        : peripherals,
  };
}

/** True when both hold the same workspace. */
export function sameSnapshot(
  first: WorkspaceSnapshot | null,
  second: WorkspaceSnapshot | null,
): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return (
    first.length === second.length &&
    first.peripherals === second.peripherals &&
    first.chunks.every((chunk, index) => sameChunk(chunk, second.chunks[index]))
  );
}

/** Every value's text, in order. */
export function snapshotTexts(snapshot: WorkspaceSnapshot): string[] {
  return snapshot.chunks.flat();
}

/** Roughly how many bytes `snapshot` adds on top of `previous`: its new
 *  chunks, plus `newText` characters of value text made since then. */
export function snapshotCost(
  snapshot: WorkspaceSnapshot,
  previous: WorkspaceSnapshot | null,
  newText: number,
): number {
  const pointer = 8;
  let cost = snapshot.chunks.length * pointer + newText;

  for (const [index, chunk] of snapshot.chunks.entries())
    if (chunk !== previous?.chunks[index]) cost += chunk.length * pointer;

  if (snapshot.peripherals !== previous?.peripherals)
    cost += snapshot.peripherals.length;

  return cost;
}

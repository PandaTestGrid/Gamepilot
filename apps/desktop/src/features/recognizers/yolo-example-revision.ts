/** Shared invalidation for every AI preview, including the material sidebar. */
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
let allRevision = 0;

export function invalidateYoloExamples(label?: string): void {
  if (label === undefined) {
    allRevision += 1;
    revisions.clear();
  } else {
    revisions.set(label, (revisions.get(label) ?? 0) + 1);
  }
  listeners.forEach((listener) => listener());
}

export function subscribeYoloExamples(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getYoloExamplesRevision(label: string): string {
  return `${allRevision}:${revisions.get(label) ?? 0}`;
}

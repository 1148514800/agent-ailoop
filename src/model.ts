import type { Run } from "../shared/types.ts";

export function mergeRuns(snapshot: Run[], older: Run[]) {
  const byId = new Map([...older, ...snapshot].map((run) => [run.id, run]));
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function streamPosition(cursor: number, seq: number) {
  return seq <= cursor ? "duplicate" : seq === cursor + 1 ? "next" : "gap";
}

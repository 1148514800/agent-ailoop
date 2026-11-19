// Older active runs appear on both the first snapshot and their historical page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRuns, streamPosition } from "../src/model.ts";
import type { Run } from "../shared/types.ts";

const row = (id: number, state: Run["state"] = "done") => ({ id, state } as Run);
test("history merges by ID and prefers current snapshots", () => {
  assert.deepEqual(mergeRuns([row(9), row(5, "claimed")], [row(7), row(5), row(1)]).map(({ id, state }) => [id, state]),
    [[9, "done"], [7, "done"], [5, "claimed"], [1, "done"]]);
});

test("a reconnect skips previously displayed facts and refuses to cross a cursor gap", () => {
  assert.equal(streamPosition(71, 71), "duplicate");
  assert.equal(streamPosition(71, 73), "gap");
  assert.equal(streamPosition(71, 72), "next");
});

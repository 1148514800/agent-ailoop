// An approval's answer event may point to a deleted queued run or a continuation whose facts are missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { routerChain } from "../server/router-history.ts";
import { taskProgress } from "../src/router-progress.ts";
import type { RouterHistory } from "../shared/router.ts";
import type { Change, Fact } from "../shared/types.ts";

const root: RouterHistory = {
  projectId: "default", projectScope: "scope", message: "test", needsPlan: false, approvals: [],
  run: { id: 1, rule: "ai-router", agent: "test", state: "done", attempts: 0, createdAt: "", claimedAt: null,
    finishedAt: null, notBefore: null, summary: "initial", error: "", link: "", session: null, usage: null, stopping: false, manual: false, events: [] },
};
const fact = (seq: number, ...changes: Change[]): Fact => ({ seq, changes, type: "test", at: seq });
const run = (id: number, summary = ""): Change => ({ table: "runs", key: String(id), row: { id, state: "done", summary } });
const card = (id: number, answer_event: number): Change => ({ table: "cards", key: String(id),
  row: { id, run_id: 1, kind: "ask", state: "decided", answer_event } });
const link = (id: number, event: number): Change => ({ table: "run_events", key: id + ":" + event,
  row: { run_id: id, event_id: event } });

test("a surviving retry absorbs both approval events without claiming unrelated runs", async () => {
  const rootFacts = [fact(1, run(1)), fact(2, card(2, 41), link(2, 41), run(2)),
    fact(3, card(3, 42), link(3, 42), run(3), link(9, 900), run(9))];
  const loaded: number[] = [];
  const result = await routerChain(root, rootFacts, async (id) => {
    loaded.push(id);
    return id === 2 ? [fact(4, { ...link(3, 42), row: null }, { ...run(3), row: null }, link(2, 42), run(2, "final"))] : null;
  });
  assert.deepEqual(loaded, [2, 3]);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.runs[0].approvals.map((item) => item.runs), [[2], [2]]);
  assert.deepEqual(taskProgress(result).leaf.map(({ run }) => run.summary), ["final"]);
  assert.equal(taskProgress(result).finished, true);
});

test("an answered card cannot turn the original summary into a final result without continuation evidence", async () => {
  const rootFacts = [fact(1, run(1)), fact(2, card(2, 41), link(2, 41), run(2))];
  const missing = await routerChain(root, rootFacts, async () => null);
  assert.equal(taskProgress(missing).label, "执行链路待核对");
  assert.equal(taskProgress(missing).finished, false);
  const waiting = await routerChain(root, [fact(1, run(1), card(2, 41))], async () => assert.fail("no confirmed link"));
  assert.match(taskProgress(waiting).label, /等待后续任务/);
  assert.equal(taskProgress(waiting).finished, false);
});

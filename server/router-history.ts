import { routerProjectOf } from "../shared/router.ts";
import type { RouterApproval, RouterChain, RouterHistory } from "../shared/router.ts";
import type { Fact, FactRow, Run } from "../shared/types.ts";
import type { Rules } from "../agent-autoloop/kernel/rules.ts";
import { executionConfig } from "./router-profiles.ts";
import { projectScopeOf } from "./router-rule-config.ts";

const text = (value: unknown) => typeof value === "string" ? value : "";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function runFromRow(id: number, last: FactRow, events: Run["events"] = []): Run {
  return {
    id, rule: text(last.rule), agent: text(last.agent), state: last.state as Run["state"], attempts: Number(last.attempts) || 0,
    createdAt: text(last.created_at), claimedAt: text(last.claimed_at) || null, finishedAt: text(last.finished_at) || null,
    notBefore: text(last.not_before) || null, summary: text(last.summary), error: text(last.error),
    link: text(last.link), session: text(last.session) || null, usage: null, stopping: !!last.cancel_at, manual: !!last.manual,
    events,
  };
}

export function routerHistory(id: number, facts: Fact[]): RouterHistory | null {
  const changes = facts.flatMap(({ changes }) => changes);
  const rows = changes.flatMap(({ table, row }) => table === "runs" && row?.id === id ? [row] : []);
  const first = rows[0], last = rows.at(-1);
  if (!first || !last || first.manual) return null;
  const events = new Map<number, FactRow>();
  const links = new Map<string, number>();
  const cards = new Map<number, FactRow>();
  for (const { table, key, row } of changes) {
    if (table === "events" && typeof row?.id === "number") events.set(row.id, row);
    if (table === "run_events" && row?.run_id === id && typeof row.event_id === "number") links.set(key, row.event_id);
    else if (table === "run_events" && !row) links.delete(key);
    if (table === "cards" && row?.run_id === id && typeof row.id === "number") cards.set(row.id, row);
    else if (table === "cards" && !row) cards.delete(Number(key));
  }
  const triggers = [...links.values()].sort((a, b) => a - b).map((event) => events.get(event));
  if (triggers.some((row) => !row || row.key !== "router-" + text(row.subject).slice(5))) return null;
  const ruleName = text(last.rule);
  const runEvents = triggers.map((row) => ({
    source: text(row?.source), type: text(row?.type), subject: text(row?.subject) || null,
    summary: text(row?.summary) || null, link: text(row?.link) || null,
  }));
  const projectId = routerProjectOf(ruleName, runEvents);
  if (!projectId) return null;

  const rulesAt = (version: unknown) => changes.find(({ table, key, row }) =>
    table === "config" && key === "rules" && row?.version === version)?.row?.value as Rules | undefined;
  const original = rulesAt(first.rules_version)?.rules.find(({ name }) => name === ruleName);
  if (!original?.cwd || !("source" in original.when)) return null;
  const source = original.when.source;
  if (runEvents.some((event) => event.source !== source)) return null;
  const actual = rulesAt(last.rules_version);
  const rule = actual?.rules.find(({ name }) => name === ruleName);
  const agent = text(last.agent);
  const execution = actual && rule && executionConfig(actual, agent, rule.execution);
  const run = runFromRow(id, last, runEvents);
  const approvals = [...cards].flatMap(([id, row]) => row.kind === "ask" && row.state === "open" ? [{ id, title: text(row.title) }] : []);
  const planName = /^ai-plan\//.test(ruleName) ? text(triggers[0]?.summary).replace(/ · (coding|research|operation|general)$/, "") :
    /-fast-[a-f0-9]{24}$/.test(ruleName) && ruleName.startsWith("ai-profile-") ? "Fast" :
    /-strong-[a-f0-9]{24}$/.test(ruleName) && ruleName.startsWith("ai-profile-") ? "Strong" : undefined;
  return {
    projectId, projectScope: projectScopeOf(projectId, original.cwd),
    message: triggers.map((row) => text(row?.detail)).filter(Boolean).join("\n\n"), needsPlan: runEvents.some(({ type }) => type.endsWith(".plan")),
    planName, execution, run, approvals,
  };
}

// A why response includes the incoming answer's fact and the cards this run created.
// When a retry merges queued rounds, a surviving run's facts can also contain a moved link.
export async function routerChain(root: RouterHistory, rootFacts: Fact[], read: (id: number) => Promise<Fact[] | null>): Promise<RouterChain> {
  const rootId = root.run.id;
  const facts = new Map<number, Fact>();
  const checked = new Set([rootId]);
  const readable = new Set([rootId]);
  const add = (batch: Fact[]) => { for (const fact of batch) facts.set(fact.seq, fact); };
  add(rootFacts);
  let limited = false;

  function relationships() {
    const runs = new Map<number, FactRow>();
    const cards = new Map<number, FactRow>();
    const links = new Map<string, FactRow>();
    for (const { changes } of [...facts.values()].sort((a, b) => a.seq - b.seq)) {
      for (const { table, key, row } of changes) {
        if (table === "runs") { if (row) runs.set(Number(key), row); else runs.delete(Number(key)); }
        if (table === "cards") { if (row) cards.set(Number(key), row); else cards.delete(Number(key)); }
        if (table === "run_events") { if (row) links.set(key, row); else links.delete(key); }
      }
    }
    const stages: RouterChain["runs"] = [];
    const todo = [rootId];
    const seen = new Set<number>();
    const candidates = new Set<number>();
    let incomplete = limited;
    while (todo.length) {
      const id = todo.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = runs.get(id);
      if (!row || !readable.has(id)) { incomplete = true; continue; }
      const approvals: RouterApproval[] = [];
      for (const [cardId, card] of cards) {
        if (card.kind !== "ask" || card.run_id !== id) continue;
        const state = card.state as RouterApproval["state"];
        const answerEvent = positive(card.answer_event) ? card.answer_event : null;
        const next = new Set<number>();
        if (answerEvent) {
          for (const link of links.values()) {
            if (link.event_id !== answerEvent || !positive(link.run_id)) continue;
            const child = link.run_id;
            if (child <= id) { incomplete = true; continue; }
            candidates.add(child);
            if (readable.has(child) && runs.has(child)) { next.add(child); todo.push(child); }
            else incomplete = true;
          }
        }
        if ((state === "done" || state === "decided") && !answerEvent) incomplete = true;
        approvals.push({ id: cardId, title: text(card.title), state, answerEvent, runs: [...next].sort((a, b) => a - b) });
      }
      stages.push({ run: runFromRow(id, row, id === rootId ? root.run.events : []), approvals });
    }
    return { candidates, incomplete, runs: stages.sort((a, b) => a.run.id - b.run.id) };
  }

  for (;;) {
    const { candidates, incomplete, runs } = relationships();
    const next = [...candidates].filter((id) => !checked.has(id));
    if (!next.length) return { incomplete, runs };
    const batch = next.slice(0, Math.min(4, 32 - checked.size));
    if (!batch.length) { limited = true; return { incomplete: true, runs }; }
    await Promise.all(batch.map(async (id) => {
      checked.add(id);
      const result = await read(id);
      if (result?.some(({ changes }) => changes.some(({ table, row }) => table === "runs" && row?.id === id))) {
        readable.add(id);
        add(result);
      }
    }));
  }
}

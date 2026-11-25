import { routerProjectOf } from "../shared/router.ts";
import type { RouterHistory } from "../shared/router.ts";
import type { Fact, FactRow, Run } from "../shared/types.ts";
import type { Rules } from "../agent-autoloop/kernel/rules.ts";
import { executionConfig } from "./router-profiles.ts";
import { digest } from "./router-rule-config.ts";

const text = (value: unknown) => typeof value === "string" ? value : "";

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
  const run: Run = {
    id, rule: ruleName, agent, state: last.state as Run["state"], attempts: Number(last.attempts) || 0,
    createdAt: text(last.created_at), claimedAt: text(last.claimed_at) || null, finishedAt: text(last.finished_at) || null,
    notBefore: text(last.not_before) || null, summary: text(last.summary), error: text(last.error),
    link: text(last.link), session: text(last.session) || null, usage: null, stopping: !!last.cancel_at, manual: !!last.manual,
    events: runEvents,
  };
  const approvals = [...cards].flatMap(([id, row]) => row.kind === "ask" && row.state === "open" ? [{ id, title: text(row.title) }] : []);
  const planName = /^ai-plan\//.test(ruleName) ? text(triggers[0]?.summary).replace(/ · (coding|research|operation|general)$/, "") :
    /-fast-[a-f0-9]{24}$/.test(ruleName) && ruleName.startsWith("ai-profile-") ? "Fast" :
    /-strong-[a-f0-9]{24}$/.test(ruleName) && ruleName.startsWith("ai-profile-") ? "Strong" : undefined;
  return {
    projectId, projectScope: digest(JSON.stringify([projectId, original.cwd])),
    message: triggers.map((row) => text(row?.detail)).filter(Boolean).join("\n\n"), needsPlan: runEvents.some(({ type }) => type.endsWith(".plan")),
    planName, execution, run, approvals,
  };
}

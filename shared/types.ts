export type Totals = { running: number; queued: number; retrying: number; unknown: number; done: number; doneToday: number; nothing: number; attention?: number };
export type Usage = { input?: number; output?: number; cached?: number; cost?: number };
export type Spending = { rounds: number; tokens: number; cached: number; cost: number; missingTokens: number; missingCost: number };
export type RunState = "queued" | "claimed" | "unknown" | "done" | "nothing" | "cancelled";
export type RunEvent = { source: string; type: string; subject: string | null; summary: string | null; link: string | null };
export type Run = {
  id: number; rule: string; agent: string; state: RunState; attempts: number; createdAt: string;
  claimedAt: string | null; finishedAt: string | null; notBefore: string | null; summary: string; error: string;
  link: string; session: string | null; usage: Usage | null; stopping: boolean; manual: boolean; events: RunEvent[];
};
export type Card = {
  id: number; version: number; kind: "ask" | "notice"; state: "open" | "decided" | "done" | "closed";
  title: string; text: string; options: string[]; recommend: number | null; choice: number | null;
  answer: string | null; by: string | null; result: string | null; rule: string | null; createdAt: string;
  decidedAt: string | null; closedAt: string | null; lane: string | null; about: string | null;
};
export type SkippedEvent = { id: number; source: string; type: string; subject: string | null; summary: string; receivedAt: string; rules: string[] };
export type Pause = { by: string; reason: string; since: string; until: string | null; skipped: { count: number; events: SkippedEvent[] } | null };
export type Rule = {
  id: string; name: string; group: string; agent: string; source: string; types: string[];
  every: string | null; next: string | null; totals: Totals; paused: Pause | null; skippedAt: string | null;
};
export type Presence = { id: string; name: string; online: boolean; seenAt: string | null };
export type Agent = Presence & { use: string; worker: string; totals: Totals };
export type Channel = Presence & { lastFailure?: { card: number; tries: number; error: string; givenUp: boolean } };
export type Elsewhere = { id: string; name: string; agent: string; source: string; every: string; next: string; where: string };
export type Timer = { rule: string; lane: string; key: string; about: string; at: string };
export type State = {
  seq: number; now: string; timezone: string; totals: Totals; spending?: { today: Spending; week: Spending };
  runs: Run[]; cards: Card[]; recentCards: Card[]; lines: Rule[]; agents: Agent[]; channels: Channel[];
  sources: { id: string; name: string; events: number }[];
  pauses: (Pause & { name: string })[]; skipped: SkippedEvent[]; elsewhere: Elsewhere[]; timers: Timer[];
  nextBefore: number | null; hasMore: boolean;
};
export type FactRow = Record<string, unknown>;
export type Change = { table: string; key: string; row: FactRow | null };
export type Fact = { seq: number; at: number | string; type: string; changes: Change[] };
export type Health = { ok: boolean; commit: string };

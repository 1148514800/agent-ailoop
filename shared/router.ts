import type { RunState } from "./types.ts";

export const ROUTER_MESSAGE_LIMIT = 4000;

export type RouterReply = { action: "reply"; needs_plan: false; answer: string };
export type ExecuteDecision = { action: "execute"; needs_plan: boolean; answer: "" };
export type RouterRun = { id: number; state: RunState; attempts: number; summary: string | null; error: string | null };

export type RouterResult = RouterReply | (ExecuteDecision & {
  eventId: number;
  status: "submitted" | "paused" | "unmatched";
  run: RouterRun | null;
});

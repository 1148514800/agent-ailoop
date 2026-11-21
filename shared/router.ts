import type { RunState } from "./types.ts";

export const ROUTER_MESSAGE_LIMIT = 4000;
export const MODEL_PROFILES = ["fast", "strong"] as const;
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelProfile = typeof MODEL_PROFILES[number];
export type ExecutionProfile = "default" | ModelProfile;
export type ProfileChoice = "auto" | ExecutionProfile;
export type ExecutionConfig = { agent: string; name: string; use: string; worker: string; model: string | null; effort: string | null; tier: string | null };
export type RouterProject = {
  id: string; name: string; rule: string; error?: string; directory?: string;
  execution?: ExecutionConfig;
  profiles?: Partial<Record<ModelProfile, ExecutionConfig>>;
};
export type RouterProjectOptions = { agents: { id: string; name: string }[] };
export type RouterMode = "auto" | "direct";

export type RouterReply = { action: "reply"; needs_plan: false; answer: string };
export type ExecuteDecision = { action: "execute"; needs_plan: boolean; answer: ""; execution_profile?: ExecutionProfile };
export type RouterRun = { id: number; state: RunState; attempts: number; summary: string | null; error: string | null };

export type RouterResult = RouterReply | (ExecuteDecision & {
  eventId: number;
  status: "submitted" | "paused" | "unmatched";
  run: RouterRun | null;
  execution?: ExecutionConfig;
});

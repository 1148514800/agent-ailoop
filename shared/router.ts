import type { RunState } from "./types.ts";

export const ROUTER_MESSAGE_LIMIT = 4000;
export const MODEL_PROFILES = ["fast", "strong"] as const;
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelProfile = typeof MODEL_PROFILES[number];
export type ExecutionProfile = "default" | ModelProfile | PlanChoice;
export type ProfileChoice = "auto" | ExecutionProfile;
export type ExecutionConfig = { agent: string; name: string; use: string; worker: string; model: string | null; effort: string | null; tier: string | null };
export type RouterProject = {
  id: string; name: string; rule: string; error?: string; directory?: string;
  execution?: ExecutionConfig;
  profiles?: Partial<Record<ModelProfile, ExecutionConfig>>;
  plans?: (ExecutionPlan & { execution: ExecutionConfig })[];
};
export type RouterProjectOptions = { agents: { id: string; name: string }[] };
export type RouterMode = "auto" | "direct";

export type RouterReply = { action: "reply"; needs_plan: false; answer: string };
export type ExecuteDecision = { action: "execute"; needs_plan: boolean; answer: ""; execution_profile?: ExecutionProfile; requirements?: TaskRequirements };
export type RouterRun = { id: number; state: RunState; attempts: number; summary: string | null; error: string | null };

export type RouterResult = RouterReply | (ExecuteDecision & {
  eventId: number;
  status: "submitted" | "paused" | "unmatched";
  run: RouterRun | null;
  execution?: ExecutionConfig;
  planName?: string;
});

export type LocalAgentKind = "codex" | "dsh" | "claude";
export type AgentScan = { workers: string[]; agents: {
  kind: LocalAgentKind; name: string; program: string | null; version: string | null;
  adapter: boolean; registered: string[]; executionVerified: boolean;
}[] };
export const TASK_TYPES = ["coding", "research", "operation", "general"] as const;
export const TOOL_CAPABILITIES = ["browser_use", "desktop_use"] as const;
export type TaskType = typeof TASK_TYPES[number];
export type ToolCapability = typeof TOOL_CAPABILITIES[number];
export type TaskRequirements = { type: TaskType; tools: ToolCapability[]; complexity: "simple" | "complex" };
export type PlanChoice = `plan:${string}`;
export const DSH_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export const DSH_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type DshProvider = {
  ref: string; api: typeof DSH_APIS[number]; baseURL: string; thinkingFormat: "default" | "deepseek"; effortValue: string;
};
export type ExecutionPlan = {
  id: string; name: string; agentId: string; model: string; effort: string; tasks: TaskType[];
  complexity: TaskRequirements["complexity"] | "any"; projects: string[]; enabled: boolean; priority: number;
  capabilities: ToolCapability[];
  provider?: DshProvider;
};

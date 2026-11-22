// DSH dsh-v0.2.2-rc.5 llm-pi-ai config.ts and catalog.ts.
import { DSH_EFFORTS, type DSH_APIS } from "../shared/router.ts";

type RecordValue = Record<string, unknown>;
export const object = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const isObject = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown, min = 1) => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const oneOf = (value: unknown, values: readonly string[]) => typeof value === "string" && values.includes(value);
const boolean = (value: unknown) => typeof value === "boolean";
const modalities = (value: unknown) => Array.isArray(value) && value.every((item) => oneOf(item, ["text", "image"]));
const effortName = (value: unknown) => oneOf(value, DSH_EFFORTS);
const wireEffort = (value: unknown) => typeof value === "string" && /^[\w.-]{1,32}$/.test(value);
const reasoning = (value: unknown) => value === false || (isObject(value) && Object.entries(object(value))
  .every(([level, spelling]) => effortName(level) && (wireEffort(spelling) || (level === "off" && spelling === null)))
  && Object.keys(object(value)).some((level) => level !== "off"));

type Check = (value: unknown) => boolean;
type Api = typeof DSH_APIS[number];
const compat: Record<Api, Record<string, Check>> = {
  "openai-completions": {
    supportsStore: boolean, supportsDeveloperRole: boolean, supportsReasoningEffort: boolean,
    supportsUsageInStreaming: boolean, supportsFinishReason: boolean, requiresToolResultName: boolean,
    requiresAssistantAfterToolResult: boolean, requiresThinkingAsText: boolean,
    requiresReasoningContentOnAssistantMessages: boolean, supportsThinkingTokenBudget: boolean,
    supportsStrictMode: boolean, supportsLongCacheRetention: boolean,
    maxTokensField: (value) => oneOf(value, ["max_completion_tokens", "max_tokens"]),
    thinkingFormat: (value) => oneOf(value, ["openai", "deepseek", "openrouter", "together", "zai", "qwen", "string-thinking", "ant-ling"]),
    thinkingTokenBudgetField: (value) => oneOf(value, ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]),
    cacheControlFormat: (value) => value === "anthropic",
    vllmPriority: (value) => Number.isSafeInteger(value),
  },
  "openai-responses": {
    supportsDeveloperRole: boolean, supportsMaxOutputTokens: boolean, supportsStrictMode: boolean, supportsLongCacheRetention: boolean,
  },
  "anthropic-messages": {
    supportsEagerToolInputStreaming: boolean, supportsLongCacheRetention: boolean, supportsCacheControlOnTools: boolean,
    supportsTemperature: boolean, forceAdaptiveThinking: boolean, allowEmptySignature: boolean, supportsStrictTools: boolean,
  },
  "google-generative-ai": {},
};

const routeFields: Record<string, Check> = {
  defaultContextWindow: numeric, defaultMaxTokens: numeric, defaultInput: modalities, reasoning: effortName,
  cacheRetention: (value) => oneOf(value, ["none", "short", "long"]),
  transport: (value) => oneOf(value, ["sse", "websocket", "websocket-cached", "auto"]),
  timeoutMs: (value) => numeric(value, 0), websocketConnectTimeoutMs: (value) => numeric(value, 0),
  streamIdleTimeoutMs: (value) => typeof value === "number" && value > 0 && value <= 2_147_483_647,
  maxRequestImageBytes: numeric, maxRequestImages: numeric, imageOffloadCountQuantum: numeric,
  requestImagePixelBudget: numeric, requestImageMaxBytes: numeric,
  thinkingBudgets: (value) => isObject(value) && Object.entries(object(value))
    .every(([level, amount]) => oneOf(level, ["minimal", "low", "medium", "high"]) && numeric(amount, 0)),
};
const modelFields: Record<string, Check> = { contextWindow: numeric, maxTokens: numeric, input: modalities, reasoningEfforts: reasoning };

class Incompatible extends Error {}

function checked(input: RecordValue, fields: Record<string, Check>, excluded: string[], reason: string) {
  const result: RecordValue = {};
  for (const [name, value] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) {
    if (excluded.includes(name)) continue;
    if (!Object.hasOwn(fields, name) || !fields[name]!(value)) throw new Incompatible(reason);
    result[name] = value;
  }
  return result;
}

function withCompat(input: RecordValue, fields: Record<string, Check>, excluded: string[], api: Api, reason: string) {
  const result = checked(input, fields, [...excluded, "compat"], reason);
  if (Object.hasOwn(input, "compat")) {
    if (!isObject(input.compat)) throw new Incompatible("请求兼容参数格式无效。");
    result.compat = checked(object(input.compat), compat[api], [], "包含当前 API 协议不支持或无法安全复用的请求兼容参数。");
  }
  return result;
}

export function providerOptions(route: RecordValue, api: Api) {
  if (Object.hasOwn(route, "headers") && (!isObject(route.headers) || Object.keys(object(route.headers)).length)) {
    throw new Incompatible("供应商使用了自定义 HTTP 请求头，无法安全复用。");
  }
  if (Object.hasOwn(route, "modelOverrides") && (!isObject(route.modelOverrides) || Object.keys(object(route.modelOverrides)).length)) {
    throw new Incompatible("供应商依赖内置模型目录的 modelOverrides，请在 DSH 中显式声明模型。");
  }
  return withCompat(route, routeFields, ["api", "baseURL", "apiKeyEnv", "models", "displayName", "headers", "modelOverrides"], api,
    "供应商包含不支持的配置，例如特殊认证、插件或自定义重试策略。");
}

export function modelOptions(model: RecordValue, api: Api) {
  return withCompat(model, modelFields, ["id", "name"], api, "模型包含不支持的配置或无效的容量、模态或推理映射。");
}

export function compatibilityError(error: unknown) {
  if (!(error instanceof Incompatible)) throw error;
  return error.message;
}

export type ImportedDshModel = {
  id: string; provider: RecordValue; model: RecordValue;
};

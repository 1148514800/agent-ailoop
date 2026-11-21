import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ExecuteDecision, ExecutionProfile, ModelProfile, RouterReply } from "../shared/router.ts";
import { ROUTER_PROMPT } from "./router-prompt.ts";

export class RouterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Config = { endpoint: URL; key: string; model: string };
type Decision = RouterReply | ExecuteDecision;
const BAD_OUTPUT = "Router 模型没有返回符合协议的 JSON，任务未提交。";

export function routerConfig(env: NodeJS.ProcessEnv): Config {
  if (env.AUTOLOOP_ROUTER_ENABLED?.trim() !== "true") {
    throw new RouterError(503, "AI Router 未启用。请在 .env.local 设置 AUTOLOOP_ROUTER_ENABLED=true。");
  }
  const base = env.AUTOLOOP_ROUTER_BASE_URL?.trim();
  const key = env.AUTOLOOP_ROUTER_API_KEY?.trim();
  const model = env.AUTOLOOP_ROUTER_MODEL?.trim();
  if (!base) throw new RouterError(503, "请配置 AUTOLOOP_ROUTER_BASE_URL。");
  if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new RouterError(503, "请配置有效的 AUTOLOOP_ROUTER_API_KEY。");
  if (!model) throw new RouterError(503, "请配置 AUTOLOOP_ROUTER_MODEL。");
  try {
    const url = new URL(base);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
    const prefix = url.pathname.replace(/\/+$/, "");
    url.pathname = prefix + (prefix.endsWith("/chat/completions") ? "" : "/chat/completions");
    return { endpoint: url, key, model };
  } catch {
    throw new RouterError(503, "AUTOLOOP_ROUTER_BASE_URL 必须使用 HTTPS，回环地址可使用 HTTP。");
  }
}

async function localRouterEnv(root: string, overrides = process.env) {
  let env: NodeJS.ProcessEnv = {};
  try { env = parseEnv(await readFile(join(root, ".env.local"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RouterError(503, "无法读取 Router 的 .env.local 配置。");
  }
  return { ...env, ...overrides };
}

export async function localRouterConfig(root: string, overrides = process.env) {
  return routerConfig(await localRouterEnv(root, overrides));
}

export async function localRouterKey(root: string) {
  return (await localRouterEnv(root).catch(() => process.env)).AUTOLOOP_ROUTER_API_KEY?.trim();
}

function decisionOf(content: string, profiles: readonly ExecutionProfile[]): Decision {
  const value = JSON.parse(content);
  if (!value || typeof value !== "object" ||
      typeof value.needs_plan !== "boolean" || typeof value.answer !== "string") throw new RouterError(502, BAD_OUTPUT);
  const fields = Object.keys(value).sort().join(",");
  const basic = fields === "action,answer,needs_plan";
  if (basic && value.action === "reply" && !value.needs_plan && value.answer.trim() && [...value.answer].length <= 1000) {
    return { action: "reply", needs_plan: false, answer: value.answer.trim() };
  }
  if (value.action === "execute" && value.answer === "") {
    if (basic && profiles[0] === "default") return { action: "execute", needs_plan: value.needs_plan, answer: "" };
    if (fields === "action,answer,execution_profile,needs_plan" && profiles.some((profile) => profile === value.execution_profile)) {
      return { action: "execute", needs_plan: value.needs_plan, execution_profile: value.execution_profile, answer: "" };
    }
  }
  throw new RouterError(502, BAD_OUTPUT);
}

async function modelText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new RouterError(502, BAD_OUTPUT);
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > 32_768) throw new RouterError(502, BAD_OUTPUT);
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function classify(
  config: Config, message: string, signal: AbortSignal, request = fetch, timeoutMs = 15_000, available: readonly ModelProfile[] = [],
): Promise<Decision> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const profiles: readonly ExecutionProfile[] = available.length ? available : ["default"];
  const prompt = ROUTER_PROMPT + "\n允许的执行档位：" + profiles.join("、") + "。";
  try {
    const response = await request(config.endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, deadline]),
      headers: { authorization: "Bearer " + config.key, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model, max_tokens: 480,
        messages: [{ role: "system", content: prompt }, { role: "user", content: message }],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RouterError(502, "Router 模型服务拒绝了请求（HTTP " + response.status + "）。任务未提交。");
    }
    const raw = await modelText(response);
    try {
      const choice = JSON.parse(raw)?.choices?.[0];
      if (typeof choice?.message?.content !== "string" || choice.message.tool_calls?.length ||
          choice.finish_reason === "length" || choice.finish_reason === "tool_calls") throw new Error();
      return decisionOf(choice.message.content, profiles);
    } catch { throw new RouterError(502, BAD_OUTPUT); }
  } catch (error) {
    if (deadline.aborted) throw new RouterError(504, "Router 模型请求超时，任务未提交。");
    if (signal.aborted) throw new RouterError(408, "Router 请求已取消，任务未提交。");
    if (error instanceof RouterError) throw error;
    throw new RouterError(502, "无法连接 Router 模型服务，任务未提交。");
  }
}

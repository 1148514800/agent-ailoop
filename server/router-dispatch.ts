import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eventRule, typeMatches } from "../agent-autoloop/kernel/rules.ts";
import { parseRules, RulesError, rulesRevision } from "../agent-autoloop/protocol/rules.ts";
import { ROUTER_MESSAGE_LIMIT } from "../shared/router.ts";
import type { ExecuteDecision, RouterReply, RouterResult } from "../shared/router.ts";
import type { RunState } from "../shared/types.ts";
import type { Hub } from "./hub.ts";
import { classify, RouterError } from "./router.ts";
import type { routerConfig } from "./router.ts";

const RULE = "ai-router";
const DIRECT = "router.task.direct";
const PLAN = "router.task.plan";
const ROUTER_TYPES = [DIRECT, PLAN];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES = new Set<RunState>(["queued", "claimed", "unknown", "done", "nothing", "cancelled"]);
const CACHE_LIMIT = 256;
type RecordOfRequest = {
  digest: string;
  decision?: RouterReply | ExecuteDecision;
  target?: string;
  eventId?: number;
  pending?: Promise<RouterResult>;
};
type HubSource = Hub & { source: NonNullable<Hub["source"]> };
type EventSubmission = { body: object; source: string; revision: string };
type EventOutcome = {
  event: number; paused: string[]; routed: string[];
  runs: { run: number; rule: string; state: RunState; attempts: number; summary: string | null; error: string | null }[];
};

async function loadRules() {
  const file = process.env.AGENT_AUTOLOOP_RULES
    ?? join(process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop"), "rules.json");
  try {
    return parseRules(await readFile(file, "utf8"), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RouterError(503, "本机找不到 rules.json，请先配置 ai-router 规则。任务未提交。");
    }
    if (error instanceof RulesError && error.issues.some((issue) => issue.startsWith("规则「ai-router」的 to 不是已登记的 Agent"))) {
      throw new RouterError(409, "ai-router 的 to 必须指向已登记的 Agent。任务未提交。");
    }
    throw new RouterError(503, "无法读取有效的 rules.json，请运行 npm run hub -- check。任务未提交。");
  }
}

async function hubRequest<T>(hub: Hub, path: string, key: string, signal: AbortSignal, submission?: EventSubmission): Promise<T> {
  try {
    const response = await fetch(hub.url + path, {
      redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      headers: { authorization: "Bearer " + key, ...(submission && {
        "content-type": "application/json", "x-autoloop-source": submission.source,
        "x-autoloop-rules-revision": submission.revision,
      }) },
      ...(submission && { method: "POST", body: JSON.stringify(submission.body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new RouterError(502, "中台拒绝了本机配置中的凭据，请检查 config.json。");
      }
      if (submission && response.status === 409) {
        throw new RouterError(409, "中台生效规则已变更，或 Source 凭据不属于配置的来源。任务未提交。");
      }
      throw new Error();
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof RouterError) throw error;
    if (submission) throw new RouterError(502, "中台未确认事件是否记录。请保留原请求并重试。");
    if (path.startsWith("/v1/events/")) throw new RouterError(502, "事件已记录，暂时无法读取关联轮次。请保留原请求并重试。");
    throw new RouterError(502, "无法核对中台规则，任务未提交。");
  }
}

async function guardRoute(hub: HubSource, signal: AbortSignal) {
  const rules = await loadRules();
  const name = hub.source.name;
  const router = rules.rules.find((rule) => rule.name === RULE);
  if (!router) throw new RouterError(409, "rules.json 缺少 ai-router 规则。任务未提交。");
  if (!eventRule(router) || router.when.source !== name || !Object.hasOwn(rules.sources, name)) {
    throw new RouterError(409, "ai-router 的 when.source 必须与 config.json 的 source.name 一致，并在 rules.json 登记。任务未提交。");
  }
  const patterns = router.when.types;
  if (!ROUTER_TYPES.every((type) => typeMatches(patterns, type))) {
    throw new RouterError(409, "ai-router 必须同时匹配 router.task.direct 和 router.task.plan。任务未提交。");
  }
  if (!Object.hasOwn(rules.agents, router.to)) {
    throw new RouterError(409, "ai-router 的 to 必须指向已登记的 Agent。任务未提交。");
  }
  if (router.parallel !== 1) {
    throw new RouterError(409, "ai-router 必须设置 parallel: 1，让不同请求各自排队。任务未提交。");
  }
  if (rules.rules.some((rule) => rule !== router && eventRule(rule) && rule.when.source === name &&
      ROUTER_TYPES.some((type) => typeMatches(rule.when.types, type)))) {
    throw new RouterError(409, "Router 事件也会命中其他规则。请缩小其他规则的事件类型范围，任务未提交。");
  }
  const active = await hubRequest<{ rulesRevision?: string }>(hub, "/v1/state", hub.owner, signal);
  if (!active?.rulesRevision || !/^[a-f0-9]{64}$/.test(active.rulesRevision)) {
    throw new RouterError(503, "当前中台不支持规则版本校验，请用此项目附带的中台启动。任务未提交。");
  }
  if (active.rulesRevision !== rulesRevision(rules)) {
    throw new RouterError(409, "中台当前生效的规则与本机文件不一致。请确认规则路径并等待中台加载。任务未提交。");
  }
  return active.rulesRevision;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const redactText = (text: string, secrets: string[]) => secrets.reduce((value, key) => value.replaceAll(key, "[已隐藏]"), text);
export type RouterHandler = (body: Record<string, unknown>, signal: AbortSignal) => Promise<RouterResult>;

export function createRouter(options: { config(): Promise<ReturnType<typeof routerConfig>>; loadHub(): Promise<Hub> }): RouterHandler {
  const recent = new Map<string, RecordOfRequest>();

  return async (body, signal) => {
    const { requestId, message } = body;
    if (Object.keys(body).length !== 2 || typeof requestId !== "string" || !UUID.test(requestId) ||
        typeof message !== "string" || !message.trim() || !message.isWellFormed() || [...message].length > ROUTER_MESSAGE_LIMIT) {
      throw new RouterError(400, "请输入有效的 UUID 与 1 到 4000 字的消息。");
    }
    const id = requestId.toLowerCase();
    const messageHash = digest(message);
    let entry = recent.get(id);
    if (entry && entry.digest !== messageHash) throw new RouterError(409, "该请求编号已用于另一条消息。");
    if (entry?.pending) return entry.pending;
    if (!entry) {
      if (recent.size >= CACHE_LIMIT) {
        const settled = [...recent].find(([, record]) => !record.pending);
        if (!settled) throw new RouterError(429, "Router 请求过多，请稍后重试。");
        recent.delete(settled[0]);
      }
      entry = { digest: messageHash };
      recent.set(id, entry);
    }
    const record = entry;
    record.pending = (async (): Promise<RouterResult> => {
      const config = await options.config();
      const hub = await options.loadHub().catch(() => null);
      const secrets = [...new Set([config.key, hub?.owner, hub?.source?.key, ...(hub?.secrets ?? [])]
        .filter((key): key is string => !!key))].sort((a, b) => b.length - a.length);
      if (secrets.some((key) => message.includes(key))) {
        throw new RouterError(400, "消息包含本机凭据，请移除后重试。");
      }
      if (!record.decision) {
        const decision = await classify(config, message, signal);
        record.decision = decision.action === "reply" ? { ...decision, answer: redactText(decision.answer, secrets) } : decision;
      }
      const decision = record.decision;
      if (decision.action === "reply") return { ...decision, answer: redactText(decision.answer, secrets) };
      if (signal.aborted) throw new RouterError(408, "Router 请求已取消，未继续派发。");
      if (!hub?.source) throw new RouterError(503, "执行任务需要在本机 config.json 配置有效的 Source 凭据。任务未提交。");
      const selected = { ...hub, source: hub.source };
      const target = hub.url + "/" + hub.source.name;
      if (record.target && record.target !== target) throw new RouterError(409, "该请求的中台地址或来源已改变，请在原中台核对事件。");
      const type = decision.needs_plan ? PLAN : DIRECT;
      if (!record.eventId) {
        const revision = await guardRoute(selected, signal);
        record.target = target;
        const accepted = await hubRequest<{ event: number }>(hub, "/v1/events", hub.source.key, signal, {
          source: hub.source.name, revision,
          body: { id: "router-" + id, type, subject: "task-" + id, summary: "AI Router 提交的任务", detail: message },
        });
        if (!Number.isSafeInteger(accepted?.event) || accepted.event < 1) {
          throw new RouterError(502, "中台未返回有效事件编号。请保留原请求并重试。");
        }
        record.eventId = accepted.event;
      }

      const result = await hubRequest<EventOutcome>(hub, "/v1/events/" + record.eventId, hub.source.key, signal);
      if (result?.event !== record.eventId || !Array.isArray(result.runs) ||
          !Array.isArray(result.paused) || !Array.isArray(result.routed)) {
        throw new RouterError(502, "无法确认已记录事件的关联轮次，请保留原请求并重试。");
      }
      const found = result.runs.find((run) => run.rule === RULE);
      if (found && (!Number.isSafeInteger(found.run) || found.run < 1 || !STATES.has(found.state))) {
        throw new RouterError(502, "中台返回的关联轮次无效，请保留原请求并重试。");
      }
      if (!found && result.routed.includes(RULE)) {
        throw new RouterError(502, "中台已记录规则命中，但尚未取得关联轮次，请保留原请求并重试。");
      }
      return { ...decision, eventId: result.event,
        status: found ? "submitted" : result.paused.includes(RULE) ? "paused" : "unmatched",
        run: found ? {
          id: found.run, state: found.state, attempts: found.attempts,
          summary: typeof found.summary === "string" ? redactText(found.summary, secrets) : null,
          error: typeof found.error === "string" ? redactText(found.error, secrets) : null,
        } : null,
      };
    })();
    try { return await record.pending; }
    finally { record.pending = undefined; }
  };
}

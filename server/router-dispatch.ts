import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { eventRule, typeMatches } from "../agent-autoloop/kernel/rules.ts";
import { rulesRevision } from "../agent-autoloop/protocol/rules.ts";
import { MODEL_PROFILES, ROUTER_MESSAGE_LIMIT } from "../shared/router.ts";
import type { ExecuteDecision, ExecutionConfig, ExecutionProfile, RouterMode, RouterProject, RouterReply, RouterResult } from "../shared/router.ts";
import type { RunState, State } from "../shared/types.ts";
import type { Hub } from "./hub.ts";
import { routerRecords } from "./router-records.ts";
import { classify, RouterError } from "./router.ts";
import type { routerConfig } from "./router.ts";

import { configSnapshot, dataHome, digest, eventPrefix, loadRules, metadataFile, PROJECT_PREFIX,
  readProjectMetadata, ruleName, rulesFile, validProject, withProjectLock } from "./router-rule-config.ts";
import { projectManagement } from "./router-project-management.ts";
import { codexModelIds, executionConfig, isModelProfile, profileRule, saveProfile } from "./router-profiles.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES = new Set<RunState>(["queued", "claimed", "unknown", "done", "nothing", "cancelled"]);
const CACHE_LIMIT = 256;
type RecordOfRequest = {
  digest: string;
  reply?: RouterReply;
  pending?: Promise<RouterResult>;
};
type HubSource = Hub & { source: NonNullable<Hub["source"]> };
type EventSubmission = { body: object; source: string; revision: string };
type EventOutcome = {
  event: number; paused: string[]; routed: string[];
  runs: { run: number; rule: string; state: RunState; attempts: number; summary: string | null; error: string | null }[];
};

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
      if (response.status === 404 && path.startsWith("/v1/events?key=")) return undefined as T;
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
    if (path.startsWith("/v1/events?key=")) throw new RouterError(502, "暂时无法确认上次提交是否已记录。请保留原请求并重试。");
    if (path.startsWith("/v1/events/")) throw new RouterError(502, "事件已记录，暂时无法读取关联轮次。请保留原请求并重试。");
    throw new RouterError(502, "无法核对中台规则，任务未提交。");
  }
}

type Rules = Awaited<ReturnType<typeof loadRules>>;
function projectRule(rules: Rules, id: string) {
  const name = ruleName(id);
  const rule = rules.rules.find((entry) => entry.name === name);
  if (!rule) throw new RouterError(409, "rules.json 缺少 " + name + " 规则。任务未提交。");
  return rule;
}

async function validateProject(rules: Rules, id: string, source: string) {
  const rule = projectRule(rules, id);
  if (!eventRule(rule) || rule.when.source !== source || !Object.hasOwn(rules.sources, source)) {
    throw new RouterError(409, "项目规则的 when.source 必须与 config.json 的 source.name 一致，并在 rules.json 登记。任务未提交。");
  }
  const types = [eventPrefix(id) + ".direct", eventPrefix(id) + ".plan"];
  const patterns = rule.when.types;
  if (!types.every((type) => typeMatches(patterns, type))) {
    throw new RouterError(409, rule.name + " 必须同时匹配 " + types.join(" 和 ") + "。任务未提交。");
  }
  if (!Object.hasOwn(rules.agents, rule.to)) {
    throw new RouterError(409, "项目规则的 to 必须指向已登记的 Agent。任务未提交。");
  }
  if (rule.parallel !== 1) {
    throw new RouterError(409, rule.name + " 必须设置 parallel: 1，让不同请求各自排队。任务未提交。");
  }
  if (rules.rules.some((other) => other !== rule && eventRule(other) && other.when.source === source &&
      types.some((type) => typeMatches(other.when.types, type)))) {
    throw new RouterError(409, "项目事件也会命中其他规则。请缩小其他规则的事件类型范围，任务未提交。");
  }
  const cwd = rule.cwd.replace(/^~(?=[/\\])/, homedir());
  const resolved = isAbsolute(cwd) ? await realpath(cwd).catch(() => null) : null;
  if (!resolved || !(await stat(resolved).catch(() => null))?.isDirectory()) {
    throw new RouterError(409, rule.name + " 的工作目录不存在或无法访问。任务未提交。");
  }
  return digest(JSON.stringify([resolved, rule.to, rules.agents[rule.to]]));
}

async function activeState(hub: Hub, signal: AbortSignal) {
  const active = await hubRequest<State & { rulesRevision: string; ruleExecutionOverrides?: boolean }>(hub, "/v1/state", hub.owner, signal);
  if (!active?.rulesRevision || !/^[a-f0-9]{64}$/.test(active.rulesRevision)) {
    throw new RouterError(503, "当前中台不支持规则版本校验，请用此项目附带的中台启动。任务未提交。");
  }
  return active;
}

async function guardRevision(hub: Hub, rules: Rules, signal: AbortSignal) {
  const active = await activeState(hub, signal);
  if (active.rulesRevision !== rulesRevision(rules)) {
    throw new RouterError(409, "中台当前生效的规则与本机文件不一致。请确认规则路径并等待中台加载。任务未提交。");
  }
  return active;
}

const redactText = (text: string, secrets: string[]) => secrets.reduce((value, key) => value.replaceAll(key, "[已隐藏]"), text);
export function createRouter(options: {
  config(): Promise<ReturnType<typeof routerConfig>>;
  loadHub(): Promise<Hub>;
  modelKey?(): Promise<string | undefined>;
}) {
  const recent = new Map<string, RecordOfRequest>();
  async function loadSource(): Promise<HubSource> {
    const hub = await options.loadHub().catch(() => null);
    if (!hub?.source) throw new RouterError(503, "执行任务需要在本机 config.json 配置有效的 Source 凭据。任务未提交。");
    return { ...hub, source: hub.source };
  }

  async function safeSecrets(hub: Hub | null) {
    return [hub?.owner, hub?.source?.key, ...(hub?.secrets ?? []), await options.modelKey?.()]
      .filter((key): key is string => !!key).sort((a, b) => b.length - a.length);
  }

  function publicExecution(config: ExecutionConfig, secrets: string[]): ExecutionConfig {
    const clean = (value: string | null) => value === null ? null : redactText(value, secrets);
    return {
      agent: clean(config.agent)!, name: clean(config.name)!, use: clean(config.use)!, worker: clean(config.worker)!,
      model: clean(config.model), effort: clean(config.effort), tier: clean(config.tier),
    };
  }

  async function modelOptions(signal: AbortSignal) {
    const ids = await codexModelIds(signal);
    if (!ids.length) return { models: ids };
    const secrets = await safeSecrets(await options.loadHub().catch(() => null));
    return { models: ids.filter((id) => !secrets.some((key) => id.includes(key))) };
  }

  async function agentModels(signal: AbortSignal) {
    const [rules, hub] = await Promise.all([loadRules(), options.loadHub().catch(() => null)]);
    if (!hub) throw new RouterError(503, "无法读取本机中台连接配置。");
    await guardRevision(hub, rules, signal);
    const secrets = await safeSecrets(hub);
    return { agents: Object.fromEntries(Object.keys(rules.agents).filter((id) => !secrets.some((key) => id.includes(key)))
      .map((id) => [id, publicExecution(executionConfig(rules, id)!, secrets)])) };
  }

  async function projects(signal: AbortSignal) {
    const [rules, hub, metadata] = await Promise.all([
      loadRules(), loadSource(), configSnapshot(metadataFile(rulesFile())).then(readProjectMetadata),
    ]);
    const revisionError = await guardRevision(hub, rules, signal).then(() => undefined, (error: RouterError) => error.message);
    const secrets = await safeSecrets(hub);
    const entries = rules.rules.flatMap((rule): RouterProject[] => {
      const id = rule.name === "ai-router" ? "default" : rule.name.startsWith(PROJECT_PREFIX) ? rule.name.slice(PROJECT_PREFIX.length) : "";
      if (!validProject(id) || rule.name !== ruleName(id)) return [];
      const entry = metadata.get(id);
      if (entry?.removed) return [];
      const managed = entry?.fingerprint === digest(JSON.stringify(rule));
      return [{ id, name: redactText(managed ? entry.name : basename(rule.cwd) || rule.name, secrets), rule: rule.name,
        ...(managed && { directory: redactText(rule.cwd, secrets) }) }];
    });
    entries.sort((a, b) => a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id));
    const classifier = await options.config().catch(() => null);
    return { classifierModel: classifier ? redactText(classifier.model, [...secrets, classifier.key].filter(Boolean)) : null,
      projects: await Promise.all(entries.map(async (entry) => {
      const error = await validateProject(rules, entry.id, hub.source.name).then(() => revisionError, (error: RouterError) => error.message);
      if (error) return { ...entry, error };
      const base = projectRule(rules, entry.id);
      const execution = publicExecution(executionConfig(rules, base.to, base.execution)!, secrets);
      const profiles = Object.fromEntries(MODEL_PROFILES.flatMap((level) => {
        const selected = profileRule(rules, entry.id, level);
        return selected ? [[level, publicExecution(executionConfig(rules, selected.to, selected.execution)!, secrets)]] : [];
      }));
      return { ...entry, execution, profiles };
    })) };
  }

  async function submit(body: Record<string, unknown>, signal: AbortSignal, mode: RouterMode = "auto") {
    const { requestId, message, needsPlan } = body;
    const choice = body.executionProfile === undefined ? "default" : body.executionProfile;
    const projectId = body.projectId === undefined && mode === "auto" ? "default" : body.projectId;
    const allowed = mode === "direct" ? ["requestId", "message", "projectId", "needsPlan", "executionProfile"] : ["requestId", "message", "projectId", "executionProfile"];
    if (Object.keys(body).some((field) => !allowed.includes(field)) || typeof requestId !== "string" || !UUID.test(requestId) ||
        typeof message !== "string" || !message.trim() || !message.isWellFormed() || [...message].length > ROUTER_MESSAGE_LIMIT) {
      throw new RouterError(400, "请输入有效的 UUID 与 1 到 4000 字的消息。");
    }
    if (!validProject(projectId)) throw new RouterError(400, "项目编号格式不正确。");
    if (mode === "direct" && typeof needsPlan !== "boolean") throw new RouterError(400, "先规划再执行必须是布尔值。");
    if (choice !== "default" && !isModelProfile(choice) && !(choice === "auto" && mode === "auto")) {
      throw new RouterError(400, "此执行模式不支持所选档位。");
    }
    const id = requestId.toLowerCase();
    const identity = [message, projectId, mode, needsPlan ?? null];
    if (choice !== "default") identity.push(choice);
    const fingerprint = digest(JSON.stringify(identity));
    const changed = () => new RouterError(409, "该请求编号已用于另一条消息、项目或执行策略。");
    let entry = recent.get(id);
    if (entry && entry.digest !== fingerprint) throw changed();
    if (entry?.pending) return entry.pending;
    if (!entry) {
      if (recent.size >= CACHE_LIMIT) {
        const settled = [...recent].find(([, record]) => !record.pending);
        if (!settled) throw new RouterError(429, "Router 请求过多，请稍后重试。");
        recent.delete(settled[0]);
      }
      entry = { digest: fingerprint };
      recent.set(id, entry);
    }
    const record = entry;
    record.pending = (async (): Promise<RouterResult> => {
      const store = routerRecords(join(dataHome(), "router-requests"), id);
      let saved = await store.request();
      if (saved && saved.digest !== fingerprint) throw changed();
      const hub = await options.loadHub().catch(() => null);
      const modelKey = await options.modelKey?.();
      const secrets = [...new Set([modelKey, hub?.owner, hub?.source?.key, ...(hub?.secrets ?? [])]
        .filter((key): key is string => !!key))].sort((a, b) => b.length - a.length);
      if (secrets.some((key) => message.includes(key))) throw new RouterError(400, "消息包含本机凭据，请移除后重试。");

      const requestedRules = !saved && mode === "auto" && (body.projectId !== undefined || choice === "auto") ? await loadRules() : undefined;
      if (requestedRules && body.projectId !== undefined) projectRule(requestedRules, projectId);
      const available = requestedRules && choice === "auto"
        ? MODEL_PROFILES.flatMap((level) => {
          const variant = profileRule(requestedRules, projectId, level);
          return variant ? [[level, variant.name] as const] : [];
        })
        : [];
      const offered = new Map(available);
      let planning = saved?.needsPlan;
      let profile: ExecutionProfile = saved?.profile ?? (isModelProfile(choice) ? choice : "default");
      if (mode === "direct") planning = needsPlan as boolean;
      else if (typeof planning !== "boolean") {
        if (record.reply) return { ...record.reply, answer: redactText(record.reply.answer, secrets) };
        const config = await options.config();
        if (message.includes(config.key)) throw new RouterError(400, "消息包含本机凭据，请移除后重试。");
        if (!secrets.includes(config.key)) secrets.push(config.key);
        const decision = await classify(config, message, signal, fetch, undefined, [...offered.keys()]);
        if (decision.action === "reply") {
          saved ??= await store.bind({ digest: fingerprint, needsPlan: null, target: null });
          if (saved.digest !== fingerprint) throw changed();
          if (saved.needsPlan === null) {
            record.reply = { ...decision, answer: redactText(decision.answer, secrets) };
            return record.reply;
          }
          planning = saved.needsPlan;
          profile = saved.profile ?? "default";
        } else {
          if (saved?.needsPlan === null) throw new RouterError(409, "该请求已得到直接回答，无法重新派发。");
          planning = decision.needs_plan;
          if (choice === "auto") profile = decision.execution_profile ?? "default";
        }
      }
      if (signal.aborted) throw new RouterError(408, "Router 请求已取消，未继续派发。");
      if (!hub?.source) throw new RouterError(503, "执行任务需要在本机 config.json 配置有效的 Source 凭据。任务未提交。");
      const target = hub.url + "/" + hub.source.name;
      if (saved && saved.target !== target) throw new RouterError(409, "该请求的中台地址或来源已改变，请在原中台核对事件。");

      let rule = saved?.rule ?? ruleName(projectId);
      let eventId = saved ? await store.receipt() : undefined;
      if (saved && eventId === undefined) {
        const existing = await hubRequest<{ event: number; source: string } | undefined>(
          hub, "/v1/events?key=router-" + id, hub.source.key, signal,
        );
        if (existing) {
          if (existing.source !== hub.source.name || !Number.isSafeInteger(existing.event) || existing.event < 1) {
            throw new RouterError(409, "中台返回的事件来源或编号与本机请求不符。");
          }
          eventId = await store.confirm(existing.event);
        }
      }
      if (eventId === undefined) {
        const source = hub.source;
        const file = rulesFile();
        const dispatch = async (rules: Rules) => {
          const baseRoute = await validateProject(rules, projectId, source.name);
          const active = await guardRevision(hub, rules, signal);
          const variant = isModelProfile(profile) ? profileRule(rules, projectId, profile, saved?.rule ?? offered.get(profile)) : undefined;
          if (isModelProfile(profile) && !variant) {
            throw new RouterError(409, "所选档位未配置，或规则与当前项目配置冲突。");
          }
          if (variant && active.lines.some((line) => line.id === ruleName(projectId) && line.paused)) {
            throw new RouterError(409, "项目已暂停。请恢复项目后再提交档位任务。");
          }
          const selected = variant ?? projectRule(rules, projectId);
          const route = variant ? digest(JSON.stringify([baseRoute, variant])) : baseRoute;
          const config = publicExecution(executionConfig(rules, selected.to, selected.execution)!, secrets);
          saved ??= await store.bind({ digest: fingerprint, needsPlan: planning as boolean, target, route,
            profile, rule: selected.name, execution: config });
          if (saved.digest !== fingerprint) throw changed();
          if (saved.target !== target || saved.route !== route || saved.needsPlan === null ||
              (saved.profile ?? "default") !== profile || (saved.rule ?? ruleName(projectId)) !== selected.name) {
            throw new RouterError(409, "该请求绑定的项目、Agent 或中台配置已变更，请核对原任务。");
          }
          rule = selected.name;
          planning = saved.needsPlan;
          const type = variant ? variant.when.types[planning ? 1 : 0] : eventPrefix(projectId) + (planning ? ".plan" : ".direct");
          const revision = active.rulesRevision;
          // If a response was lost, the hub checks this same source and external ID before inserting anything.
          const accepted = await hubRequest<{ event: number }>(hub, "/v1/events", source.key, signal, {
            source: source.name, revision,
            body: { id: "router-" + id, type, subject: "task-" + id, summary: "AI Router 提交的任务", detail: message },
          });
          if (!Number.isSafeInteger(accepted?.event) || accepted.event < 1) {
            throw new RouterError(502, "中台未返回有效事件编号。请保留原请求并重试。");
          }
          return store.confirm(accepted.event);
        };
        const rules = await loadRules();
        const entry = projectId === "default" ? undefined
          : readProjectMetadata(await configSnapshot(metadataFile(file))).get(projectId);
        eventId = entry || isModelProfile(profile) ? await withProjectLock(file, signal, async () => {
          const metadata = readProjectMetadata(await configSnapshot(metadataFile(file)));
          if (metadata.get(projectId)?.removed) throw new RouterError(409, "该项目已从 AI Router 移除。任务未提交。");
          return dispatch(await loadRules());
        }) : await dispatch(rules);
      }

      const result = await hubRequest<EventOutcome>(hub, "/v1/events/" + eventId, hub.source.key, signal);
      if (result?.event !== eventId || !Array.isArray(result.runs) ||
          !Array.isArray(result.paused) || !Array.isArray(result.routed)) {
        throw new RouterError(502, "无法确认已记录事件的关联轮次，请保留原请求并重试。");
      }
      const found = result.runs.find((run) => run.rule === rule);
      if (!found && [...result.routed, ...result.paused].some((name) => name !== rule)) {
        throw new RouterError(409, "该请求编号已有其他规则的事件。请核对原任务。");
      }
      if (found && (!Number.isSafeInteger(found.run) || found.run < 1 || !STATES.has(found.state))) {
        throw new RouterError(502, "中台返回的关联轮次无效，请保留原请求并重试。");
      }
      if (!found && result.routed.includes(rule)) {
        throw new RouterError(502, "中台已记录规则命中，但尚未取得关联轮次，请保留原请求并重试。");
      }
      const decision: ExecuteDecision = { action: "execute", needs_plan: planning, answer: "" };
      return { ...decision, execution_profile: profile, ...(saved?.execution && { execution: saved.execution }), eventId: result.event,
        status: found ? "submitted" : result.paused.includes(rule) ? "paused" : "unmatched",
        run: found ? {
          id: found.run, state: found.state, attempts: found.attempts,
          summary: typeof found.summary === "string" ? redactText(found.summary, secrets) : null,
          error: typeof found.error === "string" ? redactText(found.error, secrets) : null,
        } : null,
      };
    })();
    try { return await record.pending; }
    finally { record.pending = undefined; }
  }
  const { confirmLoaded, ...management } = projectManagement({ loadSource, activeState, guardRevision, validateProject, modelKey: options.modelKey });
  async function changeProfile(body: Record<string, unknown>, signal: AbortSignal) {
    const hub = await loadSource();
    const secrets = await safeSecrets(hub);
    return saveProfile(body, signal, secrets, async (rules, id) => {
      await validateProject(rules, id, hub.source.name);
      const active = await guardRevision(hub, rules, signal);
      if (active.ruleExecutionOverrides !== true) {
        throw new RouterError(503, "当前中台版本不支持模型档位。请从此项目重启中台后再保存。");
      }
    }, (rules, file, raw) => confirmLoaded(hub, rules, file, raw));
  }
  return Object.assign(submit, { projects, agentModels, modelOptions, changeProfile, ...management });
}

export type RouterHandler = ReturnType<typeof createRouter>;

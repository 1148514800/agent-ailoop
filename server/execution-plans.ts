import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eventRule, typeMatches, type Rule, type Rules } from "../agent-autoloop/kernel/rules.ts";
import type { Hub } from "./hub.ts";
import { CODEX_EFFORTS, TASK_TYPES } from "../shared/router.ts";
import type { ExecutionPlan, PlanChoice, TaskRequirements, ToolCapability } from "../shared/router.ts";
import type { Run } from "../shared/types.ts";
import { configSnapshot, dataHome, digest, metadataFile, parseRouterRules, readProjectMetadata,
  replaceConfig, ruleName, rulesFile, validProject, withProjectLock } from "./router-rule-config.ts";
import { prepareDshProvider, removeUnpublishedDshProvider, writeDshProvider } from "./dsh-provider.ts";
import { RouterError } from "./router.ts";

type Entry = { plan: ExecutionPlan; variants: Record<string, string>; agentVersion: string; verified?: Record<string, ToolCapability[]> };
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const planFile = (file: string) => file + ".router-plans.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isPlanChoice = (value: unknown): value is PlanChoice =>
  typeof value === "string" && value.startsWith("plan:") && uuid.test(value.slice(5));
export const isPlanRule = (name: string, project: string) => name.startsWith("ai-plan/" + project + "/");

export async function readPlans() {
  const snapshot = await configSnapshot(planFile(rulesFile()));
  try {
    const entries: Entry[] = snapshot ? JSON.parse(snapshot.raw) : [];
    if (!Array.isArray(entries)) throw new Error();
    return { snapshot, entries };
  } catch {
    throw new RouterError(503, "无法读取执行方案。");
  }
}

function overlaps(rules: Rules, candidate: Rule & { when: { source: string; types: string[] } }) {
  return rules.rules.some((rule) => rule.name !== candidate.name && eventRule(rule) &&
    rule.when.source === candidate.when.source && candidate.when.types.some((type) => typeMatches(rule.when.types, type)));
}

function variant(base: Rule & { when: { source: string; types: string[] } }, plan: ExecutionPlan, rules: Rules, project: string) {
  const revision = digest(JSON.stringify([base, plan.id, plan.name, plan.agentId, plan.model, plan.effort,
    rules.agents[plan.agentId], ...(plan.provider ? [plan.provider.ref] : [])])).slice(0, 24);
  return { ...base, name: "ai-plan/" + project + "/" + revision, to: plan.agentId,
    when: { source: base.when.source, types: ["router.plan." + revision + ".direct", "router.plan." + revision + ".plan"] },
    execution: { model: plan.model || null, effort: plan.effort || null, pauseWith: base.name, ...(plan.provider && { providerRef: plan.provider.ref }) },
    prompt: [base.prompt, "读取 context.json 的事件详情。router.plan.*.plan 表示先阅读项目并制定计划再执行。"].filter(Boolean).join("\n\n"),
  };
}

export function planRule(entry: Entry, rules: Rules, project: string) {
  const { plan } = entry;
  const base = rules.rules.find((item) => item.name === ruleName(project));
  const agent = rules.agents[plan.agentId];
  if (!base || !eventRule(base) || !agent || digest(JSON.stringify(agent)) !== entry.agentVersion) return undefined;
  const expected = variant(base, plan, rules, project);
  const registered = rules.rules.find((rule) => rule.name === entry.variants[project]);
  if (JSON.stringify(expected) !== JSON.stringify(registered) || overlaps(rules, expected)) return undefined;
  return expected;
}

export function matchingPlans(entries: Entry[], rules: Rules, project: string) {
  return entries.flatMap((entry) => {
    if (!entry.plan.enabled || !entry.plan.projects.includes(project)) return [];
    const rule = planRule(entry, rules, project);
    const plan = { ...entry.plan, capabilities: entry.verified?.[project] ?? [] };
    return rule ? [{ plan, rule }] : [];
  });
}

export function choosePlan(entries: ReturnType<typeof matchingPlans>, requirements: TaskRequirements, choice: unknown, probe: boolean) {
  const satisfiesTools = (plan: ExecutionPlan) => requirements.tools.every((tool) => plan.capabilities.includes(tool));
  if (isPlanChoice(choice)) {
    const selected = entries.find(({ plan }) => plan.id === choice.slice(5));
    if (!selected || (!probe && (!satisfiesTools(selected.plan) || !selected.plan.tasks.includes(requirements.type)))) {
      throw new RouterError(409, "所选方案不可用，或缺少此任务所需的类型或已验证工具能力。");
    }
    return selected;
  }
  if (choice === "auto") {
    const score = (plan: ExecutionPlan) => (plan.complexity === requirements.complexity ? 2 : plan.complexity === "any" ? 1 : 0);
    const found = entries.filter(({ plan }) => satisfiesTools(plan) && plan.tasks.includes(requirements.type))
      .sort((a, b) => score(b.plan) - score(a.plan) || b.plan.priority - a.plan.priority || a.plan.id.localeCompare(b.plan.id))[0];
    if (found) return found;
  }
  if (requirements.tools.length) throw new RouterError(409, "没有适用且已验证所需工具能力的方案。请先配置并验证执行方案。");
}

const toolsByName: Record<ToolCapability, { server: string; tool: string }> = {
  browser_use: { server: "playwright", tool: "browser_snapshot" },
  desktop_use: { server: "desktop", tool: "screenshot" },
};

async function workerEvidence(run: Run, capability: ToolCapability) {
  const folder = join(dataHome(), "worker", "runs", run.id + "-" + (run.attempts + 1));
  const names = await readdir(folder).catch(() => []);
  const expected = toolsByName[capability];
  for (const name of names.filter((file) => /^stdout-[1-9]\d*\.log$/.test(file))) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > 16 * 1024 * 1024) continue;
    const log = await readFile(path, "utf8").catch(() => "");
    let session = false;
    let successful = false;
    for (const line of log.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === "thread.started" && event.thread_id === run.session) session = true;
        const item = event?.item;
        if (event?.type === "item.completed" && item?.type === "mcp_tool_call" && item.status === "completed" &&
            item.server === expected.server && item.tool === expected.tool && item.result && !item.error) successful = true;
      } catch {}
    }
    if (session && successful) return true;
  }
  return false;
}

export const probeMessage = (tool: ToolCapability) => {
  const { server, tool: name } = toolsByName[tool];
  return "只读能力验证。通过 MCP 调用 " + server + "/" + name +
    "，只执行这一项。不要导航、点击、输入、修改文件或对外发送信息。完成后只报告成功或失败。";
};

export function planManagement(deps: {
  hub(): Promise<Hub & { source: NonNullable<Hub["source"]> }>;
  guard(hub: Hub, rules: Rules, signal: AbortSignal): Promise<{ ruleExecutionOverrides?: boolean; ruleProviderOverrides?: boolean; runs: Run[] }>;
  validate(rules: Rules, id: string, source: string): Promise<string>;
  confirm(hub: Hub, rules: Rules, file: string, raw: string): Promise<void>;
  secrets(hub: Hub): Promise<string[]>;
}) {
  async function changePlan(body: Record<string, unknown>, signal: AbortSignal) {
    const { id, name, agentId, model, effort, tasks, complexity, projects, enabled, priority, provider } = body;
    if (Object.keys(body).length !== (provider === undefined ? 10 : 11) || typeof id !== "string" || (id && !uuid.test(id)) ||
        typeof name !== "string" || !name.trim() || name.length > 80 || !name.isWellFormed() || /[\x00-\x1f\x7f]/.test(name) ||
        typeof agentId !== "string" || typeof model !== "string" || (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) ||
        typeof effort !== "string" || !Array.isArray(tasks) || !tasks.length || tasks.length > TASK_TYPES.length ||
        !tasks.every((task) => TASK_TYPES.includes(task)) || !Array.isArray(projects) || !projects.length || projects.length > 25 ||
        !projects.every(validProject) || typeof enabled !== "boolean" || typeof priority !== "number" ||
        !Number.isInteger(priority) || priority < 0 || priority > 100 ||
        (complexity !== "simple" && complexity !== "complex" && complexity !== "any")) {
      throw new RouterError(400, "请检查执行方案字段和授权项目。");
    }
    const plan: ExecutionPlan = { id: id || randomUUID(), name: name.trim(), agentId, model, effort, tasks: [...new Set(tasks)],
      complexity, projects: [...new Set(projects)], enabled, priority, capabilities: [] };
    const file = rulesFile();
    return withProjectLock(file, signal, async () => {
      const hub = await deps.hub();
      const before = await configSnapshot(file);
      if (!before) throw new RouterError(503, "找不到规则文件。");
      const rules = parseRouterRules(before.raw);
      const active = await deps.guard(hub, rules, signal);
      if (!active.ruleExecutionOverrides) throw new RouterError(503, "请先启动此项目附带的中台。");
      const { snapshot, entries } = await readPlans();
      const existing = entries.find((entry) => entry.plan.id === id);
      if (id ? !existing : entries.length >= 50) throw new RouterError(409, "方案不存在或已达到本机方案数量上限。");
      const secrets = await deps.secrets(hub);
      if (secrets.some((key) => [plan.name, plan.agentId, plan.model, ...plan.projects].some((field) => field.includes(key)))) {
        throw new RouterError(400, "方案包含本机凭据。");
      }
      const agent = Object.hasOwn(rules.agents, agentId) && rules.agents[agentId];
      if (!agent || !["codex", "claude", "dsh"].includes(agent.use) ||
          (agent.use !== "dsh" && provider !== undefined) ||
          (agent.use === "dsh" && provider === undefined && (model || effort)) ||
          (agent.use !== "dsh" && effort && !(agent.use === "codex" ? CODEX_EFFORTS.includes(effort as typeof CODEX_EFFORTS[number])
            : ["low", "medium", "high", "xhigh", "max"].includes(effort)))) {
        throw new RouterError(400, "Agent 不支持所选模型或推理配置。");
      }
      let route: Awaited<ReturnType<typeof prepareDshProvider>> | undefined;
      if (provider !== undefined) {
        if (!active.ruleProviderOverrides) throw new RouterError(503, "请升级并重启本机 Hub 和 Worker 后再配置 DSH 供应商。");
        if (agent.worker !== hub.localWorker) throw new RouterError(409, "DSH 自定义供应商仅可绑定本机 Worker。");
        const prior = existing?.plan;
        route = await prepareDshProvider(provider, model, effort, prior?.provider && prior.agentId === agentId
          ? { provider: prior.provider, model: prior.model, effort: prior.effort } : undefined);
        if (route.secret.length >= 8 && [plan.name, ...plan.projects].some((field) => field.includes(route!.secret))) {
          throw new RouterError(400, "方案名称和项目不能包含 API Key。");
        }
        plan.provider = route.provider;
      }
      const metadata = readProjectMetadata(await configSnapshot(metadataFile(file)));
      const agentVersion = digest(JSON.stringify(agent));
      const variants: Record<string, string> = Object.create(null);
      const rawRules = JSON.parse(before.raw);
      for (const project of plan.projects) {
        if (metadata.get(project)?.removed) {
          if (!enabled && existing?.plan.projects.includes(project)) continue;
          throw new RouterError(409, "所选项目已移除。");
        }
        await deps.validate(rules, project, hub.source.name);
        const base = rules.rules.find((rule) => rule.name === ruleName(project))!;
        if (!eventRule(base)) throw new RouterError(409, "项目规则不是事件规则。");
        const candidate = variant(base, plan, rules, project);
        const prior = rules.rules.find((rule) => rule.name === candidate.name);
        if (overlaps(rules, candidate) || (prior && JSON.stringify(prior) !== JSON.stringify(candidate))) {
          throw new RouterError(409, "方案规则与现有规则冲突。");
        }
        variants[project] = candidate.name;
        if (!prior) rawRules.rules.push(candidate);
      }
      const verified = Object.fromEntries(Object.entries(existing?.verified ?? {}).filter(([project]) =>
        existing?.agentVersion === agentVersion && !!variants[project] && variants[project] === existing.variants[project]));
      plan.capabilities = [...new Set(Object.values(verified).flat())];
      const raw = encode(rawRules);
      const prepared = parseRouterRules(raw);
      if (route?.create) await writeDshProvider(route.provider, route.secret, model, effort);
      try {
        await replaceConfig(file, before, raw, async () => { await deps.guard(hub, rules, signal); });
      } catch (error) {
        if (route?.create) await removeUnpublishedDshProvider(route.provider);
        throw error;
      }
      await deps.confirm(hub, prepared, file, raw);
      await replaceConfig(planFile(file), snapshot, encode([...entries.filter((entry) => entry !== existing), { plan, variants, agentVersion, verified }]));
      return { id: plan.id };
    });
  }

  async function verifyPlan(body: Record<string, unknown>, signal: AbortSignal) {
    const { id, runId, tool } = body;
    if (Object.keys(body).length !== 3 || typeof id !== "string" || !uuid.test(id) || !Number.isSafeInteger(runId) ||
        (tool !== "browser_use" && tool !== "desktop_use")) throw new RouterError(400, "请输入有效的能力验证轮次。");
    const file = rulesFile();
    return withProjectLock(file, signal, async () => {
      const hub = await deps.hub();
      const before = await configSnapshot(file);
      if (!before) throw new RouterError(503, "找不到规则文件。");
      const rules = parseRouterRules(before.raw);
      const active = await deps.guard(hub, rules, signal);
      const { snapshot, entries } = await readPlans();
      const entry = entries.find((item) => item.plan.id === id);
      const agent = entry && rules.agents[entry.plan.agentId];
      const run = active.runs.find((item) => item.id === runId && item.state === "done" && item.agent === entry?.plan.agentId);
      const project = entry?.plan.projects.find((id) => planRule(entry, rules, id)?.name === run?.rule);
      if (!entry || !agent || agent.use !== "codex" || agent.worker !== hub.localWorker ||
          !run?.session || !project || !run.events.some((event) => event.summary === "方案能力验证 " + tool) ||
          !await workerEvidence(run, tool)) throw new RouterError(409, "未找到该方案版本在本机 Worker 上成功调用指定工具的证据。");
      const capabilities = [...new Set<ToolCapability>([...(entry.verified?.[project] ?? []), tool])];
      entry.verified = { ...entry.verified, [project]: capabilities };
      entry.plan.capabilities = [...new Set(Object.values(entry.verified).flat())];
      await replaceConfig(planFile(file), snapshot, encode(entries));
      return { capabilities };
    });
  }
  return { changePlan, verifyPlan };
}

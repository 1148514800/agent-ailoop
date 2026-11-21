import { randomUUID } from "node:crypto";
import { eventRule, typeMatches, type Rule, type Rules } from "../agent-autoloop/kernel/rules.ts";
import type { Hub } from "./hub.ts";
import { CODEX_EFFORTS, TASK_TYPES } from "../shared/router.ts";
import type { ExecutionPlan, PlanChoice, TaskRequirements, ToolCapability } from "../shared/router.ts";
import { rulesRevision } from "../agent-autoloop/protocol/rules.ts";
import { verifiedBrowserInteraction } from "./browser-proof.ts";
import { variantPrompt } from "./router-task-prompt.ts";
import type { Run } from "../shared/types.ts";
import { configSnapshot, digest, metadataFile, parseRouterRules, readProjectMetadata,
  replaceConfig, ruleName, rulesFile, validProject, withProjectLock } from "./router-rule-config.ts";
import { configuredDshRoute } from "./dsh-catalog.ts";
import { prepareDshProvider, removeUnpublishedDshProvider, writeDshProvider } from "./dsh-provider.ts";
import { RouterError } from "./router.ts";

type Entry = { plan: ExecutionPlan; variants: Record<string, string>; agentVersion: string; proofVersion?: 2; verified?: Record<string, ToolCapability[]> };
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const planFile = (file: string) => file + ".router-plans.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isPlanChoice = (value: unknown): value is PlanChoice =>
  typeof value === "string" && value.startsWith("plan:") && uuid.test(value.slice(5));
export const isPlanRule = (name: string, project: string) => name.startsWith("ai-plan/" + project + "/");

export async function readPlans() {
  const snapshot = await configSnapshot(planFile(rulesFile()));
  try {
    const value = snapshot ? JSON.parse(snapshot.raw) : [];
    let entries: Entry[] = Array.isArray(value) ? value : value.active;
    if (!Array.isArray(entries)) throw new Error();
    if (value.pending) {
      const current = await configSnapshot(rulesFile());
      if (current) {
        const rules = parseRouterRules(current.raw);
        const additions: string[] = value.pending.additions ?? [];
        if (rulesRevision(rules) === value.pending.revision ||
            (additions.length > 0 && additions.every((name) => rules.rules.some((rule) => rule.name === name)))) {
          entries = value.pending.entries;
        }
      }
    }
    if (!Array.isArray(entries)) throw new Error();
    return { snapshot, entries: entries.map((entry) => entry.proofVersion === 2 ? entry
      : { ...entry, verified: undefined, plan: { ...entry.plan, capabilities: [] } }) };
  } catch {
    throw new RouterError(503, "无法读取执行方案。");
  }
}

function overlaps(rules: Rules, candidate: Rule & { when: { source: string; types: string[] } }) {
  return rules.rules.some((rule) => rule.name !== candidate.name && eventRule(rule) &&
    rule.when.source === candidate.when.source && candidate.when.types.some((type) => typeMatches(rule.when.types, type)));
}

function variant(base: Rule & { when: { source: string; types: string[] } }, plan: ExecutionPlan, rules: Rules, project: string, legacy = false) {
  const revision = digest(JSON.stringify([base, plan.id, plan.name, plan.agentId, plan.model, plan.effort,
    rules.agents[plan.agentId], ...(plan.provider ? [plan.provider.ref] : []), ...(!legacy ? [variantPrompt(base.prompt)] : [])])).slice(0, 24);
  return { ...base, name: "ai-plan/" + project + "/" + revision, to: plan.agentId,
    when: { source: base.when.source, types: ["router.plan." + revision + ".direct", "router.plan." + revision + ".plan"] },
    execution: { model: plan.model || null, effort: plan.effort || null, pauseWith: base.name, ...(plan.provider && { providerRef: plan.provider.ref }) },
    prompt: legacy ? [base.prompt, "读取 context.json 的事件详情。router.plan.*.plan 表示先阅读项目并制定计划再执行。"].filter(Boolean).join("\n\n") : variantPrompt(base.prompt),
  };
}

export function planRule(entry: Entry, rules: Rules, project: string) {
  const { plan } = entry;
  const base = rules.rules.find((item) => item.name === ruleName(project));
  const agent = rules.agents[plan.agentId];
  if (!base || !eventRule(base) || !agent || digest(JSON.stringify(agent)) !== entry.agentVersion) return undefined;
  const current = variant(base, plan, rules, project);
  const expected = entry.variants[project] === current.name ? current : variant(base, plan, rules, project, true);
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
        const imported = provider && typeof provider === "object" && Object.keys(provider).length === 1 && "existing" in provider
          ? await configuredDshRoute(provider.existing, model, effort) : undefined;
        route = await prepareDshProvider(imported?.settings ?? provider, model, effort, prior?.provider && prior.agentId === agentId
          ? { provider: prior.provider, model: prior.model, effort: prior.effort } : undefined);
        if (route.secret.length >= 8 && [plan.name, ...plan.projects].some((field) => field.includes(route!.secret))) {
          throw new RouterError(400, "方案名称和项目不能包含 API Key。");
        }
        plan.provider = { ...route.provider, ...(imported && { source: imported.source }) };
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
      const next = [...entries.filter((entry) => entry !== existing), { plan, variants, agentVersion, verified, proofVersion: 2 as const }];
      if (route?.create) await writeDshProvider(route.provider, route.secret, model, effort);
      const sidecar = planFile(file);
      const revision = rulesRevision(prepared);
      const additions = prepared.rules.filter((rule) => !rules.rules.some(({ name }) => name === rule.name)).map(({ name }) => name);
      let staged;
      try {
        if (revision === rulesRevision(rules)) {
          await replaceConfig(sidecar, snapshot, encode(next), async () => {
            await deps.guard(hub, rules, signal);
            if ((await configSnapshot(file))?.raw !== before.raw) throw new RouterError(409, "规则在保存期间发生变更，请重试。");
          });
          return { id: plan.id };
        }
        await replaceConfig(sidecar, snapshot, encode({ active: entries, pending: { revision, additions, entries: next } }));
        staged = await configSnapshot(sidecar);
      } catch (error) {
        if (route?.create && !staged) await removeUnpublishedDshProvider(route.provider);
        throw error;
      }
      try {
        await replaceConfig(file, before, raw, async () => { await deps.guard(hub, rules, signal); });
      } catch (error) {
        if (route?.create) await removeUnpublishedDshProvider(route.provider);
        throw error;
      }
      await deps.confirm(hub, prepared, file, raw);
      await replaceConfig(sidecar, staged, encode(next));
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
          !run?.session || !project || tool !== "browser_use" || !await verifiedBrowserInteraction(run)) throw new RouterError(409, "未找到该方案版本在本机 Worker 上成功调用指定工具的证据。");
      const capabilities = [...new Set<ToolCapability>([...(entry.verified?.[project] ?? []), tool])];
      entry.proofVersion = 2;
      entry.verified = { ...entry.verified, [project]: capabilities };
      entry.plan.capabilities = [...new Set(Object.values(entry.verified).flat())];
      await replaceConfig(planFile(file), snapshot, encode(entries));
      return { capabilities };
    });
  }
  return { changePlan, verifyPlan };
}

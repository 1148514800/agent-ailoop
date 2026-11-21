import { variantPrompt } from "./router-task-prompt.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Rule, Rules } from "../agent-autoloop/kernel/rules.ts";
import { eventRule, typeMatches } from "../agent-autoloop/kernel/rules.ts";
import { CODEX_EFFORTS, MODEL_PROFILES } from "../shared/router.ts";
import type { ExecutionConfig, ModelProfile } from "../shared/router.ts";
import { configSnapshot, digest, metadataFile, parseRouterRules, readProjectMetadata,
  replaceConfig, ruleName, rulesFile, validProject, withProjectLock } from "./router-rule-config.ts";
import { RouterError } from "./router.ts";

type Overrides = { model: string | null; effort: string | null; providerRef?: string };
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const profilePrompt = "对于 router.profile. 开头的任务事件，读取 context.json 的 detail 作为任务资料。.direct 表示直接处理并验证，.plan 表示先阅读项目并制定简短计划，再执行与验证。";

export async function codexModelIds(signal: AbortSignal): Promise<string[]> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    const raw = await readFile(join(home, "models_cache.json"), { encoding: "utf8", signal });
    const catalog: { models?: unknown } | null = JSON.parse(raw);
    if (!Array.isArray(catalog?.models)) return [];
    const ids = new Set<string>();
    for (const model of catalog.models) {
      if (model?.visibility === "list" && typeof model.slug === "string" && modelId.test(model.slug)) ids.add(model.slug);
    }
    return [...ids];
  } catch {
    return [];
  }
}

export const isModelProfile = (value: unknown): value is ModelProfile => value === "fast" || value === "strong";
const prefix = (projectId: string, profile: ModelProfile) => "ai-profile-" + projectId + "-" + profile + "-";

export function isProjectProfile(name: string, projectId: string, profile?: ModelProfile) {
  return (profile ? [profile] : MODEL_PROFILES).some((level) => {
    const start = prefix(projectId, level);
    return name.startsWith(start) && /^[a-f0-9]{24}$/.test(name.slice(start.length));
  });
}

function makeProfile(base: Rule & { when: { source: string; types: string[] } }, projectId: string, profile: ModelProfile, settings: Overrides, legacy = false) {
  const version = digest(JSON.stringify([base, profile, settings.model, settings.effort, ...(!legacy ? [variantPrompt(base.prompt)] : [])])).slice(0, 24);
  return {
    ...base,
    name: prefix(projectId, profile) + version,
    when: { source: base.when.source, types: [`router.profile.${version}.direct`, `router.profile.${version}.plan`] },
    execution: { ...settings, pauseWith: base.name },
    prompt: legacy ? [base.prompt, profilePrompt].filter(Boolean).join("\n\n") : variantPrompt(base.prompt),
  };
}

function conflicts(rules: Rules, candidate: ReturnType<typeof makeProfile>) {
  return rules.rules.some((other) => other.name !== candidate.name && eventRule(other) &&
    other.when.source === candidate.when.source && candidate.when.types.some((type) => typeMatches(other.when.types, type)));
}

export function profileRule(rules: Rules, projectId: string, profile: ModelProfile, pinned?: string) {
  const base = rules.rules.find((rule) => rule.name === ruleName(projectId));
  if (!base || !eventRule(base) || rules.agents[base.to]?.use !== "codex") return undefined;
  if (pinned && !isProjectProfile(pinned, projectId, profile)) return undefined;
  const rule = pinned
    ? rules.rules.find(({ name }) => name === pinned)
    : rules.rules.findLast(({ name }) => isProjectProfile(name, projectId, profile));
  if (!rule?.execution) return undefined;
  const { model, effort } = rule.execution;
  if ((model !== null && !modelId.test(model)) ||
      (effort !== null && !CODEX_EFFORTS.some((value) => value === effort))) return undefined;
  const current = makeProfile(base, projectId, profile, { model, effort });
  const expected = current.name === rule.name ? current : makeProfile(base, projectId, profile, { model, effort }, true);
  if (JSON.stringify(rule) !== JSON.stringify(expected) || conflicts(rules, expected)) return undefined;
  return expected;
}

export function executionConfig(rules: Rules, agentId: string, override?: Overrides): ExecutionConfig | undefined {
  const agent = rules.agents[agentId];
  if (!agent) return undefined;
  return {
    agent: agentId, name: agent.name, use: agent.use, worker: agent.worker,
    model: agent.use === "dsh" && !override?.providerRef ? null : override ? override.model : agent.model ?? null,
    effort: agent.use === "dsh" && !override?.providerRef ? null : override ? override.effort : agent.effort ?? null,
    tier: agent.tier ?? null,
  };
}

export async function saveProfile(
  body: Record<string, unknown>, signal: AbortSignal, secrets: string[],
  check: (rules: Rules, projectId: string) => Promise<void>,
  confirmLoaded: (rules: Rules, file: string, raw: string) => Promise<void>,
) {
  const { projectId, profile, model, effort } = body;
  if (Object.keys(body).length !== 4 || !validProject(projectId) || !isModelProfile(profile) ||
      typeof model !== "string" || typeof effort !== "string") throw new RouterError(400, "模型档位字段不正确。");
  const cleanedModel = model.trim();
  if ((cleanedModel && !modelId.test(cleanedModel)) || secrets.some((secret) => cleanedModel.includes(secret))) {
    throw new RouterError(400, "请输入有效的模型 ID，或留空继承 CLI 默认。");
  }
  if (effort !== "" && !CODEX_EFFORTS.some((value) => effort === value)) throw new RouterError(400, "不支持该思考强度。");
  const file = rulesFile();
  await withProjectLock(file, signal, async () => {
    const before = await configSnapshot(file);
    if (!before) throw new RouterError(409, "找不到项目规则文件。");
    const rules = parseRouterRules(before.raw);
    const entries = readProjectMetadata(await configSnapshot(metadataFile(file)));
    if (entries.get(projectId)?.removed) throw new RouterError(409, "该项目已从 AI Router 移除。");
    await check(rules, projectId);
    const base = rules.rules.find((rule) => rule.name === ruleName(projectId))!;
    if (!eventRule(base) || rules.agents[base.to]?.use !== "codex") throw new RouterError(409, "Fast / Strong 仅适用于 Codex 项目。");
    const candidate = makeProfile(base, projectId, profile, { model: cleanedModel || null, effort: effort || null });
    if (conflicts(rules, candidate)) throw new RouterError(409, "档位事件会命中其他规则，未保存。");
    const existing = rules.rules.find(({ name }) => name === candidate.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
      throw new RouterError(409, "档位规则名与现有配置冲突，未保存。");
    }
    const updated = JSON.parse(before.raw) as { rules: Rule[] };
    // Keep earlier rules because queued work and later retries still refer to those exact versions.
    updated.rules = [...updated.rules.filter(({ name }) => name !== candidate.name), candidate];
    const raw = JSON.stringify(updated, null, 2) + "\n";
    const prepared = parseRouterRules(raw);
    await replaceConfig(file, before, raw, async () => {
      if (signal.aborted) throw new RouterError(408, "模型档位设置已取消。");
    });
    await confirmLoaded(prepared, file, raw);
  });
  return { projectId, profile };
}

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { rulesRevision } from "../agent-autoloop/protocol/rules.ts";
import type { State } from "../shared/types.ts";
import type { Hub } from "./hub.ts";
import { configSnapshot, dataHome, digest, eventPrefix, loadRules, metadataFile, parseRouterRules, PROJECT_PREFIX,
  readProjectMetadata, replaceConfig, ruleName, rulesFile, validProject, withProjectLock } from "./router-rule-config.ts";
import { RouterError } from "./router.ts";

type SourceHub = Hub & { source: NonNullable<Hub["source"]> };
type Rules = ReturnType<typeof parseRouterRules>;
type Active = State & { rulesRevision: string };
const prompt = "读取本轮 context.json 中的事件详情，将 detail 作为开发任务。direct 类型直接处理并验证；plan 类型先阅读项目、制定简短计划，再执行与验证。只操作本规则授权的工作目录，遵守现有权限与审批机制。";
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();
const enc = (value: object) => JSON.stringify(value, null, 2) + "\n";

function contains(parent: string, child: string) {
  if (process.platform === "darwin") {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}

export async function projectDirectory(input: string) {
  if (!isAbsolute(input) || input.split(process.platform === "win32" ? /[/\\]/ : "/").includes("..") || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new RouterError(400, "请输入不含路径回退的本机绝对目录。");
  }
  const cwd = await realpath(input).catch(() => null);
  if (!cwd || !(await stat(cwd).catch(() => null))?.isDirectory()) {
    throw new RouterError(400, "项目目录不存在或无法访问。");
  }
  const user = await realpath(homedir()).catch(() => homedir());
  const data = await realpath(dataHome()).catch(() => resolve(dataHome()));
  const protectedPaths = process.platform === "win32"
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA]
    : ["/System", "/Library", "/Applications", "/etc", "/private/etc", "/bin", "/sbin", "/usr", "/dev", "/proc", "/sys",
      "/run", "/root", "/var/root", "/var/db", "/var/run", "/var/log", "/private/var/root", "/private/var/db",
      "/private/var/run", "/private/var/log"];
  const privateFolders = [".ssh", ".gnupg", ".aws", ".config", ".kube", ".local", ".agent-autoloop", ".codex", ".claude", "Library"];
  const sensitive = [data, ...protectedPaths.filter((path): path is string => !!path), ...privateFolders.map((path) => resolve(user, path))];
  if (cwd === parse(cwd).root || ["/private", "/var", "/Volumes", "/tmp", "/private/tmp"].includes(cwd) ||
      contains(cwd, user) || contains(cwd, data) || sensitive.some((path) => contains(path, cwd))) {
    throw new RouterError(400, "请选择具体的工程目录。系统目录和本机凭据目录不能用于执行任务。");
  }
  return cwd;
}

export function projectManagement(deps: {
  loadSource(): Promise<SourceHub>;
  activeState(hub: Hub, signal: AbortSignal): Promise<Active>;
  guardRevision(hub: Hub, rules: Rules, signal: AbortSignal): Promise<Active>;
  validateProject(rules: Rules, id: string, source: string): Promise<string>;
  modelKey?(): Promise<string | undefined>;
}) {
  async function projectOptions(signal: AbortSignal) {
    const [hub, rules] = await Promise.all([deps.loadSource(), loadRules()]);
    await deps.guardRevision(hub, rules, signal);
    const secrets = [hub.owner, hub.source.key, ...hub.secrets, await deps.modelKey?.()]
      .filter((value): value is string => !!value);
    return { agents: Object.entries(rules.agents).filter(([id]) => !secrets.some(key => id.includes(key)))
      .map(([id, agent]) => ({ id, name: secrets.reduce((name, key) => name.replaceAll(key, "[已隐藏]"), agent.name) })) };
  }

  async function confirmLoaded(hub: Hub, prepared: Rules, file: string, raw: string) {
    const expected = rulesRevision(prepared);
    const deadline = AbortSignal.timeout(5000);
    while (!deadline.aborted) {
      const snapshot = await configSnapshot(file);
      if (snapshot?.raw !== raw) throw new RouterError(409, "保存后规则文件又被修改。请刷新项目列表并核对当前规则。");
      const active = await deps.activeState(hub, deadline).catch(() => null);
      if (active?.rulesRevision === expected && (await configSnapshot(file))?.raw === raw) return;
      if (!deadline.aborted) await sleep(100);
    }
    throw new RouterError(503, "规则已保存，但未能确认中台加载。请检查中台连接和规则文件路径，再刷新项目列表。");
  }

  async function changeProject(operation: "create" | "remove", body: Record<string, unknown>, signal: AbortSignal) {
    const fields = operation === "create" ? ["name", "directory", "agentId"] : ["projectId"];
    if (Object.keys(body).length !== fields.length || fields.some((field) => typeof body[field] !== "string")) {
      throw new RouterError(400, "项目字段不正确。");
    }
    const file = rulesFile();
    return withProjectLock(file, signal, async () => {
      const hub = await deps.loadSource();
      const before = await configSnapshot(file);
      if (!before) throw new RouterError(503, "找不到规则文件。");
      const rules = parseRouterRules(before.raw);
      const active = await deps.guardRevision(hub, rules, signal);
      const metaFile = metadataFile(file);
      const metaBefore = await configSnapshot(metaFile);
      const metadata = readProjectMetadata(metaBefore);
      const writeMetadata = () => replaceConfig(metaFile, metaBefore, enc(Object.fromEntries(metadata)), async () => {
        const latest = await configSnapshot(file);
        if (latest?.raw !== before.raw || latest.inode !== before.inode || latest.device !== before.device) {
          throw new RouterError(409, "规则文件已被其他进程修改，请重新加载后重试。");
        }
        if (signal.aborted) throw new RouterError(408, "项目操作已取消。");
      });

      if (operation === "remove") {
        const id = body.projectId;
        if (!validProject(id) || id === "default") throw new RouterError(400, "默认项目不能移除，其他项目需要有效的项目编号。");
        const rule = rules.rules.find((item) => item.name === ruleName(id));
        const entry = metadata.get(id);
        if (!rule || !entry || entry.fingerprint !== digest(JSON.stringify(rule))) {
          throw new RouterError(409, "只能移除由网页添加且仍由网页管理的项目。");
        }
        if (entry.removed) return { projectId: id };
        const totals = active.lines?.find((line) => line.id === rule.name)?.totals;
        if (!totals || !Array.isArray(active.cards) || !Array.isArray(active.timers) ||
            ![totals.queued, totals.running, totals.unknown].every((value) => Number.isSafeInteger(value) && value >= 0)) {
          throw new RouterError(503, "无法确认该项目的任务状态，请稍后重试。");
        }
        const remaining = totals.queued + totals.running + totals.unknown;
        const timers = active.timers.filter((timer) => timer.rule === rule.name).length;
        const cards = active.cards.filter((card) => card.rule === rule.name && card.kind === "ask").length;
        if (remaining || timers || cards) {
          const reasons = [remaining && `${remaining} 个未完成任务`, timers && `${timers} 个待复查事项`, cards && `${cards} 个待回答审批`].filter(Boolean);
          throw new RouterError(409, "无法移除该项目。还有 " + reasons.join("、") + "，请处理完后重试。");
        }
        // A Source or worker outside this console can still submit work. Keep the rule for any such work.
        metadata.set(id, { ...entry, removed: true });
        await writeMetadata();
        await confirmLoaded(hub, rules, file, before.raw);
        return { projectId: id };
      }

      const name = (body.name as string).trim();
      const directory = (body.directory as string).trim();
      const agentId = body.agentId as string;
      if (!name || [...name].length > 80 || !name.isWellFormed() || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new RouterError(400, "请输入 1 到 80 字的项目名称。");
      }
      if (!Object.hasOwn(rules.agents, agentId)) throw new RouterError(400, "请选择已注册的 Agent。");
      if (!Object.hasOwn(rules.sources, hub.source.name)) throw new RouterError(409, "本机配置中的事件来源尚未登记。");
      const cwd = await projectDirectory(directory);
      const secrets = [hub.owner, hub.source.key, ...hub.secrets, await deps.modelKey?.()];
      if (secrets.some((key) => key && [name, directory, cwd, agentId].some((value) => value.includes(key)))) {
        throw new RouterError(400, "项目字段包含本机凭据，请修改后重试。");
      }
      const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42).replace(/-$/, "");
      const id = slug || "project-" + digest(nameKey(name)).slice(0, 12);
      if (id === "default" || rules.rules.some((rule) => rule.name === ruleName(id))) {
        throw new RouterError(409, "项目编号与现有项目或保留编号冲突，请换一个名称。");
      }
      if (rules.rules.some((rule) => {
        const projectId = rule.name === "ai-router" ? "default" : rule.name.slice(PROJECT_PREFIX.length);
        if (rule.name !== "ai-router" && !rule.name.startsWith(PROJECT_PREFIX)) return false;
        const entry = metadata.get(projectId);
        return nameKey(entry?.name ?? basename(rule.cwd)) === nameKey(name);
      })) throw new RouterError(409, "该项目名称已存在，请换一个名称。");

      const updated = JSON.parse(before.raw);
      updated.rules.push({
        name: ruleName(id),
        when: { source: hub.source.name, types: [eventPrefix(id) + ".direct", eventPrefix(id) + ".plan"] },
        to: agentId, cwd, parallel: 1, resume: false, prompt,
      });
      const raw = enc(updated);
      const prepared = parseRouterRules(raw);
      await deps.validateProject(prepared, id, hub.source.name);
      const created = prepared.rules.find((rule) => rule.name === ruleName(id))!;
      metadata.set(id, { name, fingerprint: digest(JSON.stringify(created)) });
      const staged = enc(Object.fromEntries(metadata));
      await writeMetadata();
      try {
        await replaceConfig(file, before, raw, async () => {
          if (signal.aborted) throw new RouterError(408, "项目操作已取消。");
        });
      } catch (error) {
        const current = await configSnapshot(metaFile).catch(() => null);
        if (current?.raw === staged) await replaceConfig(metaFile, current, metaBefore?.raw ?? "{}\n").catch(() => {});
        throw error;
      }
      await confirmLoaded(hub, prepared, file, raw);
      return { projectId: id };
    });
  }
  return { projectOptions, changeProject };
}

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseRules, RulesError } from "../agent-autoloop/protocol/rules.ts";
import { RouterError } from "./router.ts";

export const PROJECT_PREFIX = "ai-project-";
export const validProject = (id: unknown): id is string => typeof id === "string" &&
  id.length <= 42 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
export const ruleName = (id: string) => id === "default" ? "ai-router" : PROJECT_PREFIX + id;
export const eventPrefix = (id: string) => id === "default" ? "router.task" : "router.project." + id;
export const dataHome = () => process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop");
export const rulesFile = () => resolve(process.env.AGENT_AUTOLOOP_RULES ?? join(dataHome(), "rules.json"));
export const metadataFile = (file: string) => file + ".router-projects.json";
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function parseRouterRules(raw: string) {
  try {
    return parseRules(raw, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (error) {
    if (error instanceof RulesError && error.issues.some((issue) => /^规则「ai-(?:router|project-[a-z0-9-]+)」的 to 不是已登记的 Agent/.test(issue))) {
      throw new RouterError(409, "项目规则的 to 必须指向已登记的 Agent。任务未提交。");
    }
    throw new RouterError(503, "无法读取有效的 rules.json，请运行 npm run hub -- check。任务未提交。");
  }
}

export async function loadRules() {
  const raw = await readFile(rulesFile(), "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new RouterError(503, error.code === "ENOENT"
      ? "本机找不到 rules.json，请先配置 ai-router 规则。任务未提交。"
      : "无法读取本机规则文件。请检查 rules.json。");
  });
  return parseRouterRules(raw);
}

export async function configSnapshot(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new RouterError(409, "网页修改需要使用普通配置文件。");
    return { raw: await readFile(file, "utf8"), mode: info.mode & 0o777, inode: info.ino, device: info.dev };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof RouterError) throw error;
    throw new RouterError(503, "无法读取项目配置。请检查本机文件权限。");
  }
}

export type ConfigSnapshot = Awaited<ReturnType<typeof configSnapshot>>;

export async function replaceConfig(file: string, before: ConfigSnapshot, raw: string, check?: () => Promise<void>) {
  const temporary = file + "." + randomUUID() + ".tmp";
  let created = false;
  try {
    const mode = before?.mode ?? 0o600;
    const handle = await open(temporary, "wx", mode);
    created = true;
    try {
      await handle.writeFile(raw);
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await check?.();
    const latest = await configSnapshot(file);
    if (latest?.raw !== before?.raw || latest?.mode !== before?.mode ||
        latest?.inode !== before?.inode || latest?.device !== before?.device) {
      throw new RouterError(409, "配置文件已被其他进程修改，请重新加载后重试。");
    }
    await rename(temporary, file);
  } catch (error) {
    if (error instanceof RouterError) throw error;
    throw new RouterError(503, "无法保存项目配置。请检查本机文件权限。");
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

export async function withProjectLock<T>(file: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const lock = file + ".router-projects.lock";
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (signal.aborted) throw new RouterError(408, "项目操作已取消。");
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RouterError(503, "无法建立项目配置锁，请检查本机文件权限。");
      if (Date.now() >= deadline) throw new RouterError(409, "另一个项目操作正在进行，请稍后重试。");
      await sleep(75);
    }
  }
  try { return await work(); }
  finally { await rmdir(lock); }
}

type ProjectEntry = { name: string; fingerprint: string; removed?: true };
export function readProjectMetadata(snapshot: ConfigSnapshot) {
  if (!snapshot) return new Map<string, ProjectEntry>();
  try {
    const value: unknown = JSON.parse(snapshot.raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return new Map(Object.entries(value).map(([id, entry]: [string, ProjectEntry]) => {
      if (!validProject(id) || id === "default" || !entry || typeof entry.name !== "string" ||
          !entry.name.trim() || !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          (entry.removed !== undefined && entry.removed !== true)) throw new Error();
      return [id, entry];
    }));
  } catch {
    throw new RouterError(503, "项目登记文件无法读取，请检查本机配置。");
  }
}

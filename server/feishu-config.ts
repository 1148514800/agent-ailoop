import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ROUTER_MESSAGE_LIMIT } from "../shared/router.ts";
import { validProject } from "./router-rule-config.ts";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const openId = (value: unknown): value is string => typeof value === "string" && /^ou_[a-zA-Z0-9_-]{1,100}$/.test(value);

export type FeishuUser = { projects: string[]; defaultProject?: string };
export type FeishuConfig = { program?: string; users: Map<string, FeishuUser>; maxLength: number; maxConcurrent: number };
type ConfigResult = { config?: FeishuConfig; error?: string };

export async function readFeishuConfig(home: string): Promise<ConfigResult> {
  try {
    const file = await open(join(home, "feishu-chat.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let value: unknown;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077))) {
        return { error: "请将飞书聊天配置设为仅当前用户可读写（0600）。" };
      }
      value = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    if (!record(value) || typeof value.enabled !== "boolean") throw new Error();
    if (!value.enabled) return {};
    const { program, users, maxLength = 2000, maxConcurrent = 3 } = value;
    if ((program !== undefined && (typeof program !== "string" || !isAbsolute(program) || /[\p{Cc}]/u.test(program))) ||
        !record(users) || Object.keys(users).length < 1 || Object.keys(users).length > 100 ||
        typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > ROUTER_MESSAGE_LIMIT ||
        typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) throw new Error();
    const allowed = new Map<string, FeishuUser>();
    for (const [id, user] of Object.entries(users)) {
      if (!openId(id) || !record(user) || !Array.isArray(user.projects) || user.projects.length > 100 ||
          !user.projects.every(validProject) || (user.defaultProject !== undefined &&
          (!validProject(user.defaultProject) || !user.projects.includes(user.defaultProject)))) throw new Error();
      allowed.set(id, { projects: user.projects, defaultProject: user.defaultProject });
    }
    return { config: { program, users: allowed, maxLength, maxConcurrent } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: "飞书聊天配置无效，请核对飞书配置示例。" };
  }
}

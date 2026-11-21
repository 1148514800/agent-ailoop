import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RouterError } from "./router.ts";
import type { ExecutionConfig, ExecutionProfile } from "../shared/router.ts";

export type SavedRequest = {
  digest: string;
  target: string | null;
  needsPlan: boolean | null;
  route?: string;
  profile?: ExecutionProfile;
  rule?: string;
  execution?: ExecutionConfig;
};

export function routerRecords(directory: string, id: string) {
  async function read<T>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(file, "utf8")) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RouterError(503, "无法读取 Router 重试记录。请检查本机数据目录。");
    }
  }

  // Publish a complete record without replacing a record from another console process.
  async function save<T>(file: string, value: T): Promise<T> {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
      await link(temporary, file);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await read<T>(file);
        if (existing !== undefined) return existing;
      }
      throw new RouterError(503, "无法保存 Router 重试记录。请检查本机数据目录。");
    } finally { await unlink(temporary).catch(() => {}); }
  }

  const request = join(directory, id + ".json");
  const receipt = join(directory, id + ".event.json");
  return {
    request: () => read<SavedRequest>(request),
    bind: (value: SavedRequest) => save(request, value),
    receipt: () => read<number>(receipt),
    confirm: (event: number) => save(receipt, event),
  };
}

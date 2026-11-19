import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export const exec = promisify(execFile);
export const root = join(import.meta.dirname, "..");
export const logs = join(homedir(), "Library", "Logs", "Agent Autoloop Console");
export type Availability = "ready" | "down" | "other";

export function consolePort() {
  if (process.platform !== "darwin") throw new Error("此脚本适用于 macOS。");
  const value = process.env.AUTOLOOP_CONSOLE_PORT ?? "4175";
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AUTOLOOP_CONSOLE_PORT 必须在 1 到 65535 之间。");
  }
  return port;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type Service = { label: string; prefix: string; args: string[]; record: string };
export const bundledHub = ["--disable-warning=ExperimentalWarning", join(root, "scripts", "hub.ts")];

export function services(port: number) {
  const home = resolve(process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop"));
  const service = (label: string, prefix: string, args: string[], scope: string): Service => ({
    label, prefix, args, record: join(logs, prefix + "-" + hash(root + "\0" + scope).slice(0, 20) + ".json"),
  });
  return {
    hub: service("中台", "hub", [...bundledHub, "up"], home),
    web: service("Web 控制台", "console-" + port, [join(root, "server", "main.ts")], String(port)),
  };
}

async function ensurePrivateLogs() {
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const info = await lstat(logs);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("日志目录必须由本人所有，且只允许本人访问：" + logs);
  }
}

async function identity(pid: number) {
  try {
    // The same PID can later be assigned to another process, so compare the owner, start time and full command.
    const { stdout } = await exec(
      "/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=", "-o", "lstart=", "-o", "command="],
      { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
    );
    const output = stdout.trim();
    if (output.split(/\s+/)[0] !== String(process.getuid?.())) return null;
    return hash(output);
  } catch { return null; }
}

export async function startService(service: Service, check: () => Promise<Availability>) {
  await ensurePrivateLogs();
  if (await check() === "ready") return;
  // The shell uses its own PID in the private log name, then hands that same PID to the service.
  const child = spawn("/bin/sh", [
    "-c", 'umask 077; logfile="$1-$$.log"; shift; exec "$@" > "$logfile" 2>&1',
    "start-service", join(logs, service.prefix), process.execPath, ...service.args,
  ], { cwd: root, detached: true, stdio: "ignore" });
  let failed = false;
  child.once("error", () => { failed = true; });
  child.unref();

  const deadline = Date.now() + 15_000;
  let ready = false;
  do {
    ready = (await check()) === "ready";
    if (ready || failed || child.exitCode !== null || child.signalCode !== null) break;
    await sleep(250);
  } while (Date.now() < deadline);

  const pid = child.pid;
  const signature = pid && !failed && child.exitCode === null && child.signalCode === null ? await identity(pid) : null;
  if (signature) {
    const pending = service.record + "." + process.pid;
    await writeFile(pending, JSON.stringify({ pid, signature }), { mode: 0o600 });
    await rename(pending, service.record);
  }
  if (!ready) throw new Error(service.label + "启动后未能连通。请查看日志：" + join(logs, service.prefix + "-" + pid + ".log"));
}

export async function stopService(service: Service) {
  const info = await lstat(service.record).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(service.label + "的进程记录权限不正确。");
  }
  const { pid, signature } = JSON.parse(await readFile(service.record, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error(service.label + "的进程记录无效。");
  }
  if (await identity(pid) !== signature) return false;
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await identity(pid) !== signature) return true;
    await sleep(200);
  }
  throw new Error(service.label + "仍在退出，请稍后重试。");
}

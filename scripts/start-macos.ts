import { execFile, spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { loadHub } from "../server/hub.ts";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const logs = join(homedir(), "Library", "Logs", "Agent Autoloop Console");
type Availability = "ready" | "down" | "other";
type Probe = () => Promise<Availability>;

async function probe(url: string, matches: (res: Response) => Promise<boolean>): Promise<Availability> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    return res.ok && await matches(res) ? "ready" : "other";
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? "down" : "other";
  }
}

async function consoleAt(url: string): Promise<Availability> {
  const session = await probe(url + "api/session", async (res) => (await res.json())?.authenticated === false);
  if (session !== "ready") return session;
  return probe(url, async (res) => (await res.text()).includes("<title>Autoloop · 管理控制台</title>"));
}

async function ensurePrivateLogs() {
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const info = await lstat(logs);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("日志目录必须由本人所有，且只允许本人访问：" + logs);
  }
}

async function startService(program: string, args: string[], prefix: string, label: string, check: Probe) {
  await ensurePrivateLogs();
  if (await check() === "ready") return;
  // The shell uses its own PID in the private log name, then hands that same PID to the service.
  const child = spawn("/bin/sh", [
    "-c", 'umask 077; logfile="$1-$$.log"; shift; exec "$@" > "$logfile" 2>&1',
    "start-service", join(logs, prefix), program, ...args,
  ], { cwd: root, detached: true, stdio: "ignore" });
  let failed = false;
  child.once("error", () => { failed = true; });
  child.unref();

  const deadline = Date.now() + 15_000;
  do {
    if (await check() === "ready") return;
    if (failed || child.exitCode !== null || child.signalCode !== null) break;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(label + "启动后未能连通。请查看日志：" + join(logs, prefix + "-" + child.pid + ".log"));
}

function npm(args: string[], error: string) {
  const result = spawnSync("npm", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(result.error ? "找不到可用的 npm。请检查 Node.js 安装。" : error);
}

async function buildConsole() {
  const [vite, installed, required] = await Promise.all([
    stat(join(root, "node_modules", ".bin", "vite")).catch(() => null),
    stat(join(root, "node_modules", ".package-lock.json")).catch(() => null),
    stat(join(root, "package-lock.json")),
  ]);
  if (!vite || !installed || installed.mtimeMs < required.mtimeMs) {
    console.log("正在安装控制台依赖…");
    npm(["ci", "--no-audit", "--no-fund"], "安装控制台依赖失败。");
  }
  npm(["run", "build"], "构建控制台失败。");
}

async function showLoginCode(port: number) {
  try {
    const { stdout } = await exec("/usr/sbin/lsof", ["-tnP", "-iTCP@127.0.0.1:" + port, "-sTCP:LISTEN"]);
    const pid = stdout.trim();
    if (/^[1-9]\d*$/.test(pid)) {
      const file = join(logs, "console-" + port + "-" + pid + ".log");
      const info = await lstat(file);
      if (info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0) {
        const code = (await readFile(file, "utf8")).match(/^控制台登录码 ([\w-]{24})$/m)?.[1];
        if (code) {
          console.log("控制台登录码 " + code);
          return;
        }
      }
    }
  } catch { /* A console started independently has no launcher log. */ }
  console.log("如需登录，请使用该控制台启动时显示的登录码。");
}

async function main() {
  if (process.platform !== "darwin") throw new Error("此启动器适用于 macOS。");
  const value = process.env.AUTOLOOP_CONSOLE_PORT ?? "4175";
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("AUTOLOOP_CONSOLE_PORT 必须在 1 到 65535 之间。");
  }
  const hub = await loadHub().catch(() => {
    throw new Error("无法读取本机中台配置。请先安装 Agent Autoloop，并检查 config.json 中的本人密钥和回环地址。");
  });
  const consoleUrl = "http://127.0.0.1:" + port + "/";
  const checkHub = () => probe(hub.url + "/healthz", async (res) => {
    const body = await res.json();
    return body?.ok === true && typeof body.commit === "string";
  });
  const checkConsole = () => consoleAt(consoleUrl);
  const [hubStatus, consoleStatus] = await Promise.all([checkHub(), checkConsole()]);
  if (consoleStatus === "other") throw new Error("控制台端口 " + port + " 已被占用，或当前服务无法识别。可用 AUTOLOOP_CONSOLE_PORT 指定其他端口。");
  if (hubStatus === "other") throw new Error("中台地址 " + hub.url + " 有响应或无法探测，请检查中台和端口占用。");
  if (hubStatus === "down" && !hub.localService) throw new Error("此配置没有本机中台。请启动配置所指向的中台。");

  if (consoleStatus === "down") await buildConsole();
  if (hubStatus === "down") {
    console.log("正在启动本机中台…");
    await startService("agent-autoloop", ["up"], "hub", "中台", checkHub);
  } else {
    console.log("复用已运行的中台。");
  }
  if (consoleStatus === "down") {
    console.log("正在启动控制台…");
    await startService(process.execPath, [join(root, "server", "main.ts")], "console-" + port, "控制台", checkConsole);
  } else {
    console.log("复用已运行的控制台。");
  }

  console.log("控制台地址 " + consoleUrl);
  await showLoginCode(port);
  await exec("open", [consoleUrl]).catch(() => {
    throw new Error("无法打开默认浏览器。请在浏览器中打开上面的控制台地址。");
  });
  console.log("关闭此终端窗口后，服务会继续在后台运行。");
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

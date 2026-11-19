import { spawnSync } from "node:child_process";
import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadHub } from "../server/hub.ts";
import { bundledHub, consolePort, exec, logs, root, services, startService } from "./macos-services.ts";
import type { Availability } from "./macos-services.ts";

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

async function initialize(webPort: number) {
  console.log("首次配置 Agent Autoloop。请先安装并登录要使用的命令行 Agent。");
  console.log("回车自动检测，1 选择 Codex，2 选择 Claude Code，3 输入其他 Agent 命令，0 退出。");
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  input.on("SIGINT", () => input.close());
  const lines = input[Symbol.asyncIterator]();
  const ask = async (prompt: string) => {
    process.stdout.write(prompt);
    const line = await lines.next();
    if (line.done) throw new Error("已取消初始化。");
    return line.value.trim();
  };
  let flags: string[] = [];
  let port = "";
  try {
    for (;;) {
      const choice = await ask("请选择 Agent [自动]：");
      if (!choice) break;
      if (choice === "0") throw new Error("已取消初始化。");
      if (choice === "1" || choice === "2") {
        flags = ["--agent", choice === "1" ? "codex" : "claude"];
        break;
      }
      if (choice === "3") {
        const command = await ask("请输入命令（可用 {prompt} 作为提示词参数）：");
        if (command) {
          flags = ["--command", command];
          break;
        }
      }
      console.log("请输入回车、1、2、3 或 0。");
    }

    for (;;) {
      port = await ask("中台端口 [3350]：") || "3350";
      if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65_535 && Number(port) !== webPort) {
        port = String(Number(port));
        if (await probe("http://127.0.0.1:" + port + "/healthz", async () => false) === "down") break;
        console.log("这个端口已有服务或暂时无法使用，请换一个。");
      } else {
        console.log("请填写 1 到 65535 之间、与控制台不同的端口。");
      }
    }
  } finally { input.close(); }

  const result = spawnSync(process.execPath, [...bundledHub, "init", "--no-service", "--port", port, ...flags], {
    cwd: root, stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("初始化未完成。请按上面的提示检查 Agent 后重试。");
}

async function configuredHub(port: number) {
  try { return await loadHub(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("无法读取本机中台配置。请检查 config.json 中的本人密钥和回环地址。");
    }
  }
  await initialize(port);
  return loadHub();
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
  const port = consolePort();
  const consoleUrl = "http://127.0.0.1:" + port + "/";
  const checkConsole = () => consoleAt(consoleUrl);
  const consoleStatus = await checkConsole();
  if (consoleStatus === "other") throw new Error("控制台端口 " + port + " 已被占用，或当前服务无法识别。可用 AUTOLOOP_CONSOLE_PORT 指定其他端口。");
  const hub = await configuredHub(port);
  const managed = services(port);
  const checkHub = () => probe(hub.url + "/healthz", async (res) => {
    const body = await res.json();
    return body?.ok === true && typeof body.commit === "string";
  });
  const hubStatus = await checkHub();
  if (hubStatus === "other") throw new Error("中台地址 " + hub.url + " 有响应或无法探测，请检查中台和端口占用。");
  if (hubStatus === "down" && !hub.localService) throw new Error("此配置没有本机中台。请启动配置所指向的中台。");

  if (consoleStatus === "down") await buildConsole();
  if (hubStatus === "down") {
    console.log("正在启动本机中台…");
    await startService(managed.hub, checkHub);
  } else {
    console.log("复用已运行的中台。");
  }
  if (consoleStatus === "down") {
    console.log("正在启动控制台…");
    await startService(managed.web, checkConsole);
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

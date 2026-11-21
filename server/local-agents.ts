import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Rules } from "../agent-autoloop/kernel/rules.ts";
import type { LocalAgentKind } from "../shared/router.ts";
import { RouterError } from "./router.ts";

const run = promisify(execFile);
const kinds = ["codex", "dsh", "claude"] as const;
const names = { codex: "Codex", dsh: "DeepSeek Harness", claude: "Claude Code" };

async function executable(kind: LocalAgentKind) {
  const dirs = (process.env.PATH ?? "").split(delimiter).map((path) => path.replace(/^"(.*)"$/, "$1")).filter(isAbsolute);
  dirs.push(join(homedir(), ".local/bin"), dirname(process.execPath));
  const windows = process.platform === "win32";
  if (windows && process.env.APPDATA && isAbsolute(process.env.APPDATA)) dirs.push(join(process.env.APPDATA, "npm"));
  if (!windows) dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  let discovered: string | undefined;
  try { discovered = (await import("../agent-autoloop/worker/agents.ts")).findProgram(kind); } catch {}
  const bundled = process.platform !== "darwin" ? [] : kind === "dsh"
    ? ["/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"]
    : kind === "codex" ? (await import("../agent-autoloop/plugins/codex/agent.ts")).IN_THE_APP
      : (await import("../agent-autoloop/plugins/claude/agent.ts")).inTheApp();
  const extensions = windows ? [".exe", ".cmd", ".ps1"] : [""];
  const paths = [...dirs.flatMap((dir) => extensions.map((ext) => join(dir, kind + ext))), ...bundled];
  if (discovered && isAbsolute(discovered)) paths.unshift(discovered);
  for (const file of new Set(paths)) {
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

async function inspect(kind: LocalAgentKind, signal: AbortSignal) {
  const program = await executable(kind);
  if (!program) return { kind, name: names[kind], program, version: null, adapter: false };
  const call = async (args: string[]) => {
    const [command, argv] = (await import("../agent-autoloop/host/command.ts")).commandLine([program, ...args]);
    const { stdout } = await run(command, argv, { cwd: homedir(), signal, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    return stdout;
  };
  const version = (await call(["--version"]).catch(() => "")).match(/\b\d+\.\d+\.\d+(?:[-.][\w.-]+)?\b/)?.[0] ?? null;
  const help = await call(kind === "dsh" ? ["headless", "--help"] : kind === "codex" ? ["exec", "--help"] : ["--help"]).catch(() => "");
  const expected = kind === "dsh" ? ["--json", "--approval-policy", "--permission-mode", "--session-id"]
    : kind === "codex" ? ["--json", "--model", "--sandbox"] : ["--print", "--output-format", "--permission-mode", "--model"];
  return { kind, name: names[kind], program, version, adapter: !!version && expected.every((flag) => help.includes(flag)) };
}

export async function scanAgents(rules: Rules, workerName: string | undefined, signal: AbortSignal, verified: ReadonlySet<string>) {
  const scans = await Promise.all(kinds.map((kind) => inspect(kind, signal)));
  return { workers: workerName ? [workerName] : [], agents: scans.map((scan) => {
    const matches = Object.entries(rules.agents).filter(([, agent]) => agent.use === scan.kind && agent.worker === workerName &&
      (!agent.program || agent.program === scan.program));
    return { ...scan, registered: matches.map(([id]) => id), executionVerified: matches.some(([id]) => verified.has(id)) };
  }) };
}

export async function localAgent(
  body: Record<string, unknown>, rules: Rules, workerName: string | undefined, signal: AbortSignal, secrets: string[],
) {
  const { kind, name, worker, access } = body;
  const adapter = kinds.find((item) => item === kind);
  if (Object.keys(body).length !== 4 || !adapter || typeof name !== "string" || !name.trim() ||
      name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || !name.isWellFormed() ||
      !workerName || worker !== workerName || (access !== "read" && access !== "edit" && access !== "full") ||
      secrets.some((secret) => name.includes(secret))) throw new RouterError(400, "请选择本机 Worker、受支持的适配器，并填写有效的名称和权限。");
  const scan = await inspect(adapter, signal);
  if (!scan.program || !scan.adapter) throw new RouterError(409, "本机 CLI 尚未通过对应适配器检查。");
  const prefix = adapter + "-local";
  let agentId = prefix;
  for (let suffix = 2; Object.hasOwn(rules.agents, agentId); suffix++) agentId = prefix + "-" + suffix;
  if (Object.values(rules.agents).some((agent) => agent.name === name.trim())) throw new RouterError(409, "该 Agent 名称已登记。");
  return { agentId, agent: { name: name.trim(), use: adapter, program: scan.program, worker: workerName, access } };
}

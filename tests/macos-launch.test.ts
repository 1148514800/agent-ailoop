// First launch should initialize the bundled hub once. Shutdown must only stop processes started by this launcher.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const macOS = process.platform === "darwin";

async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setup(t: TestContext, configured = true) {
  const home = await mkdtemp(join(tmpdir(), "autoloop-launch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, "Console checkout");
  const bin = join(home, "bin");
  const hubHome = join(home, "hub");
  const hubPort = await port();
  const consolePort = await port();
  const opens = join(home, "opened");
  const counters = join(home, "commands");
  const logs = join(home, "Library", "Logs", "Agent Autoloop Console");
  const hubBin = join(workspace, "agent-autoloop", "bin");
  const modules = join(workspace, "node_modules");
  await Promise.all([bin, hubHome, join(workspace, "scripts"), hubBin, modules].map((path) => mkdir(path, { recursive: true })));
  for (const part of ["启动控制台.command", "关闭控制台.command", "package-lock.json", "scripts/macos-command.sh", "scripts/macos-services.ts", "scripts/start-macos.ts", "scripts/stop-macos.ts", "scripts/hub.ts", "server", "shared", "agent-autoloop/kernel", "agent-autoloop/protocol", "agent-autoloop/host/command.ts"]) {
    await cp(join(root, part), join(workspace, part), { recursive: true });
  }
  await cp(join(root, "node_modules", "yaml"), join(modules, "yaml"), { recursive: true });
  const config = JSON.stringify({
    url: "http://127.0.0.1:" + hubPort, owner: "fixture-owner", hub: { listen: "127.0.0.1:" + hubPort },
  });
  const configFile = join(hubHome, "config.json");
  if (configured) await writeFile(configFile, config, { mode: 0o600 });
  await writeFile(join(hubBin, "agent-autoloop.ts"), String.raw`
    import { appendFileSync, writeFileSync } from "node:fs";
    import { createServer } from "node:http";
    const [command, ...args] = process.argv.slice(2);
    if (command === "init") {
      if (!args.includes("--no-service") || args[args.indexOf("--agent") + 1] !== "codex" || args[args.indexOf("--port") + 1] !== "${hubPort}") process.exit(1);
      appendFileSync(process.env.COMMANDS, "init\n");
      writeFileSync(${JSON.stringify(configFile)}, ${JSON.stringify(config)}, { flag: "wx", mode: 0o600 });
      process.exit(0);
    }
    if (command !== "up") process.exit(1);
    appendFileSync(process.env.COMMANDS, "hub\n");
    createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 404, {"content-type": "application/json"});
      res.end(JSON.stringify({ok:true,commit:"fixture"}));
    }).listen(${hubPort}, "127.0.0.1");
  `);
  const sh = (name: string, body: string) => writeFile(join(bin, name), "#!/bin/sh\nset -eu\n" + body, { mode: 0o700 });
  await sh("agent-autoloop", "exit 1");
  await sh("open", `printf '%s\\n' "$1" >> "$OPENS"`);
  await sh("npm", `printf '%s\\n' "$1" >> "$COMMANDS"
case "$1" in
  ci) mkdir -p node_modules/.bin; touch node_modules/.bin/vite node_modules/.package-lock.json ;;
  run) [ "$2" = build ]; mkdir -p dist; printf '%s\\n' '<title>Autoloop · 管理控制台</title>' > dist/index.html ;;
  *) exit 1 ;;
esac`);
  const env = {
    ...process.env, HOME: home, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin"].join(":"),
    AGENT_AUTOLOOP_HOME: hubHome, AUTOLOOP_HUB_URL: "", AUTOLOOP_CONSOLE_PORT: String(consolePort),
    OPENS: opens, COMMANDS: counters,
  };
  const command = (file: string, input = "") => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const process = execFile(join(workspace, file), [], { cwd: home, env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    process.stdin?.end(input);
  });
  const start = (input?: string) => command("启动控制台.command", input);
  const stop = () => command("关闭控制台.command");
  const pidAt = async (number: number) => {
    const { stdout } = await run("/usr/sbin/lsof", ["-t", "-nP", "-iTCP:" + number, "-sTCP:LISTEN"]);
    return Number(stdout.trim());
  };
  const cleanup = async () => {
    for (const number of [hubPort, consolePort]) {
      const pid = await pidAt(number).catch(() => 0);
      if (pid) {
        process.kill(pid);
        for (let attempt = 0; attempt < 30 && await pidAt(number).catch(() => 0) === pid; attempt++) await sleep(50);
      }
    }
  };
  return { start, stop, hubPort, consolePort, configFile, pidAt, counters, opens, logs, cleanup };
}

test("the macOS launcher initializes once and closes only its own services", { skip: !macOS, timeout: 45_000 }, async (t) => {
  const fixture = await setup(t, false);
  try {
    const { stdout: first } = await fixture.start("1\n" + fixture.hubPort + "\n");
    const pids = await Promise.all([fixture.pidAt(fixture.hubPort), fixture.pidAt(fixture.consolePort)]);
    assert.ok(pids.every(Boolean));
    assert.doesNotMatch(first, /登录码/);
    const { stdout: second } = await fixture.start();
    assert.doesNotMatch(second, /登录码/);
    assert.deepEqual(await Promise.all([fixture.pidAt(fixture.hubPort), fixture.pidAt(fixture.consolePort)]), pids);
    assert.deepEqual((await readFile(fixture.counters, "utf8")).trim().split("\n"), ["init", "ci", "run", "hub"]);
    assert.deepEqual((await readFile(fixture.opens, "utf8")).trim().split("\n"),
      Array(2).fill("http://127.0.0.1:" + fixture.consolePort + "/"));
    const log = join(fixture.logs, "console-" + fixture.consolePort + "-" + pids[1] + ".log");
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    const config = await readFile(fixture.configFile, "utf8");
    const { stdout: stopped } = await fixture.stop();
    assert.match(stopped, /中台已关闭/);
    assert.match(stopped, /Web 控制台已关闭/);
    await assert.rejects(fixture.pidAt(fixture.hubPort));
    await assert.rejects(fixture.pidAt(fixture.consolePort));
    assert.equal(await readFile(fixture.configFile, "utf8"), config);
    await fixture.stop();
  } finally { await fixture.cleanup(); }
});

test("the macOS launcher leaves an unrelated HTTP service alone", { skip: !macOS, timeout: 20_000 }, async (t) => {
  const fixture = await setup(t);
  const unrelated = createServer((_req, res) => res.end("another local website"));
  try {
    await new Promise<void>((resolve) => unrelated.listen(fixture.consolePort, "127.0.0.1", resolve));
    await assert.rejects(fixture.start(), /端口.*占用/);
    assert.equal((await fetch("http://127.0.0.1:" + fixture.consolePort)).ok, true);
    await assert.rejects(readFile(fixture.opens), { code: "ENOENT" });
    await assert.rejects(readFile(fixture.counters), { code: "ENOENT" });
  } finally {
    await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    await fixture.cleanup();
  }
});

test("the macOS launcher reuses and leaves externally started services running", { skip: !macOS, timeout: 20_000 }, async (t) => {
  const fixture = await setup(t);
  const hub = createServer((_req, res) => res.end(JSON.stringify({ ok: true, commit: "external" })));
  const web = createServer((req, res) => {
    if (req.method === "HEAD" && req.url === "/api/session") return res.writeHead(204).end();
    res.end("<title>Autoloop · 管理控制台</title>");
  });
  try {
    await Promise.all([hub, web].map((server, index) => new Promise<void>((resolve) => {
      server.listen([fixture.hubPort, fixture.consolePort][index], "127.0.0.1", resolve);
    })));
    const { stdout } = await fixture.start();
    assert.match(stdout, /复用已运行的中台/);
    assert.match(stdout, /复用已运行的控制台/);
    await fixture.stop();
    assert.equal(hub.listening && web.listening, true);
    await assert.rejects(readFile(fixture.counters), { code: "ENOENT" });
  } finally {
    await Promise.all([hub, web].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

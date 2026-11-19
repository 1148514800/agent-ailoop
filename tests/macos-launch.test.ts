// The launcher must use its bundled hub, preserve both services on a second launch, and leave unrelated listeners alone.
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

async function setup(t: TestContext) {
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
  await Promise.all([bin, hubHome, join(workspace, "scripts"), hubBin].map((path) => mkdir(path, { recursive: true })));
  for (const part of ["启动控制台.command", "package-lock.json", "scripts/start-macos.ts", "scripts/hub.ts", "server"]) {
    await cp(join(root, part), join(workspace, part), { recursive: true });
  }
  await writeFile(join(hubHome, "config.json"), JSON.stringify({
    url: "http://127.0.0.1:" + hubPort, owner: "fixture-owner", hub: { listen: "127.0.0.1:" + hubPort },
  }), { mode: 0o600 });
  await writeFile(join(hubBin, "agent-autoloop.ts"), String.raw`
    import { appendFileSync } from "node:fs";
    import { createServer } from "node:http";
    if (process.argv[2] !== "up") process.exit(1);
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
  const start = () => run(join(workspace, "启动控制台.command"), [], { cwd: home, env, timeout: 30_000 });
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
  return { start, hubPort, consolePort, pidAt, counters, opens, logs, cleanup };
}

test("the macOS launcher builds on first use and later opens the same running console", { skip: !macOS, timeout: 45_000 }, async (t) => {
  const fixture = await setup(t);
  try {
    const { stdout: first } = await fixture.start();
    const pids = await Promise.all([fixture.pidAt(fixture.hubPort), fixture.pidAt(fixture.consolePort)]);
    assert.ok(pids.every(Boolean));
    const readCode = (lines: string) => lines.match(/控制台登录码 ([A-Za-z0-9_-]{24})/)?.[1];
    const code = readCode(first);
    assert.ok(code);
    const { stdout: second } = await fixture.start();
    assert.ok(readCode(second) === code);
    assert.deepEqual(await Promise.all([fixture.pidAt(fixture.hubPort), fixture.pidAt(fixture.consolePort)]), pids);
    assert.deepEqual((await readFile(fixture.counters, "utf8")).trim().split("\n"), ["ci", "run", "hub"]);
    assert.deepEqual((await readFile(fixture.opens, "utf8")).trim().split("\n"),
      Array(2).fill("http://127.0.0.1:" + fixture.consolePort + "/"));
    const log = join(fixture.logs, "console-" + fixture.consolePort + "-" + pids[1] + ".log");
    assert.equal((await stat(log)).mode & 0o777, 0o600);
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

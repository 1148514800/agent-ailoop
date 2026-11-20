// Requests with a local session must route through the real hub with separate event lanes and stable deduplication.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createConsole } from "../server/proxy.ts";
import { loadHub } from "../server/hub.ts";
import { createRouter } from "../server/router-dispatch.ts";
import { routerConfig } from "../server/router.ts";
import { hubClient } from "../agent-autoloop/protocol/client.ts";

const home = await mkdtemp(join(tmpdir(), "autoloop-router-test-"));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const rule = { name: "ai-router", when: { source: "workstation", types: ["router.task.*"] }, to: "lab", cwd: home, prompt: "测试。", parallel: 1 };
const rules = { sources: { workstation: { name: "工作站" }, other: { name: "其他来源" } }, agents: {
  lab: { name: "试验", use: "command", command: ["node", "--version"], worker: "offline-worker" },
}, channels: {}, rules: [rule] };
await writeFile(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify(rules));
const hubRuntime = await import("../agent-autoloop/host/runtime.ts");
const { serve } = await import("../agent-autoloop/host/http.ts");
const hub = serve(0);
const owner = hubRuntime.addKey("owner", "owner");
const source = hubRuntime.addKey("source", "workstation");
const modelKey = "router-test-provider-key";
let modelCalls = 0;
const model = createServer(async (req, res) => {
  modelCalls++;
  assert.equal(req.headers.authorization, "Bearer " + modelKey);
  assert.equal(req.url, "/v1/chat/completions");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  assert.ok(!raw.includes(owner) && !raw.includes(source) && !raw.includes(modelKey));
  const message = JSON.parse(raw).messages[1].content;
  const decision = message === "你好" || message === "检查模型回应" ? {
    action: "reply", needs_plan: false, answer: message === "你好" ? "你好，有什么可以帮你？" : modelKey + " " + source,
  } : { action: "execute", needs_plan: message.includes("重构"), answer: "" };
  res.end(JSON.stringify({ choices: [{ message: { content: message === "非法" ? "bad json" : JSON.stringify(decision) } }] }));
});
function address(server: Server) { return "http://127.0.0.1:" + (server.address() as AddressInfo).port; }
let base: string, hubUrl: string, cookie: string, csrf: string, consoleServer: Server;
let key = modelKey;
const options = { loadHub, config: async () => routerConfig({
  AUTOLOOP_ROUTER_ENABLED: "true", AUTOLOOP_ROUTER_API_KEY: key,
  AUTOLOOP_ROUTER_BASE_URL: address(model) + "/v1", AUTOLOOP_ROUTER_MODEL: "fixture-model",
}) };
before(async () => {
  if (!hub.listening) await once(hub, "listening");
  hubUrl = address(hub);
  await writeFile(join(home, "config.json"), JSON.stringify({ url: hubUrl, owner, source: { name: "workstation", key: source } }));
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  consoleServer = createConsole({ loadHub, router: createRouter(options) });
  await new Promise<void>((resolve) => consoleServer.listen(0, "127.0.0.1", resolve));
  base = address(consoleServer);
  const session = await fetch(base + "/api/session");
  cookie = session.headers.get("set-cookie")!.split(";")[0];
  csrf = (await session.json()).csrf;
});
after(async () => {
  for (const server of [consoleServer, model, hub]) {
    if (!server?.listening) continue;
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
  hubRuntime.db.close();
  await rm(home, { recursive: true, force: true });
});

const post = (message: string, requestId = randomUUID(), headers: Record<string, string> = { cookie, "x-console-csrf": csrf }) =>
  fetch(base + "/api/router/message", {
    method: "POST", headers: { origin: base, "content-type": "application/json", ...headers }, body: JSON.stringify({ message, requestId }),
  });
const state = () => hubRuntime.stateOf();
const routerRuns = () => state().runs.filter((run) => run.rule === "ai-router");

test("missing session, invalid CSRF and foreign origins never reach the model", async () => {
  assert.equal((await post("你好", randomUUID(), {})).status, 401);
  assert.equal((await post("你好", randomUUID(), { cookie })).status, 403);
  assert.equal((await post("你好", randomUUID(), { cookie, "x-console-csrf": csrf, origin: "https://another.invalid" })).status, 403);
  assert.equal(modelCalls, 0);
});

test("direct replies and invalid model decisions do not create hub events", async () => {
  const before = state().seq;
  const chat = await post("你好");
  assert.equal(chat.status, 200);
  assert.deepEqual(await chat.json(), { action: "reply", needs_plan: false, answer: "你好，有什么可以帮你？" });
  assert.equal((await post("非法")).status, 502);
  assert.equal(state().seq, before);
  assert.deepEqual(routerRuns(), []);
});

test("simple and complex requests create independently deduplicated runs while the worker is offline", async () => {
  const requestId = randomUUID();
  const simple = await (await post("帮我修改 README 中的错别字", requestId)).json();
  const before = modelCalls;
  const again = await (await post("帮我修改 README 中的错别字", requestId)).json();
  assert.equal(modelCalls, before);
  assert.deepEqual(again, simple);
  const restarted = createRouter(options);
  assert.deepEqual(await restarted({ requestId, message: "帮我修改 README 中的错别字" }, new AbortController().signal), simple);
  const complex = await (await post("帮我重构调度模块并测试")).json();
  assert.equal(simple.status, "submitted");
  assert.equal(simple.needs_plan, false);
  assert.equal(complex.needs_plan, true);
  assert.equal(simple.run.state, "queued");
  assert.equal(complex.run.state, "queued");
  assert.notEqual(complex.eventId, simple.eventId);
  assert.notEqual(complex.run.id, simple.run.id);
  const runs = routerRuns();
  const first = runs.find((run) => run.id === simple.run.id)!;
  const second = runs.find((run) => run.id === complex.run.id)!;
  assert.deepEqual([first.events[0].type, second.events[0].type], ["router.task.direct", "router.task.plan"]);
  assert.equal(first.events[0].subject, "task-" + requestId);
  assert.equal(runs.length, 2);
  assert.equal((await post("另一条消息", requestId)).status, 409);
  assert.equal(state().agents[0].online, false);
});

test("the registered worker can claim both Router runs and receives the planning event in its job", async () => {
  const key = hubRuntime.addKey("worker", "offline-worker");
  const worker = hubClient(hubUrl, key);
  for (const [index, run] of [...routerRuns()].reverse().entries()) {
    const { job } = await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true });
    assert.equal(job.run, run.id);
    assert.equal(job.context.events[0].type, index === 0 ? "router.task.direct" : "router.task.plan");
    assert.equal(routerRuns().find(({ id }) => id === run.id)?.state, "claimed");
    assert.equal(state().agents[0].online, true);
    await worker.result(job.run, job.token, { outcome: "done", summary: "已验收领取" });
  }
});

test("a paused event is recorded for replay without claiming that work started", async () => {
  hubRuntime.execute("pauseRule", ["ai-router", "owner", {}]);
  const paused = await (await post("修改 README")).json();
  assert.equal(paused.status, "paused");
  assert.equal(paused.run, null);
  assert.ok(paused.eventId > 0);
  hubRuntime.execute("resumeRule", ["ai-router"]);
});

test("bad disk rules stop execution before the event is recorded", async () => {
  const disk = process.env.AGENT_AUTOLOOP_RULES!;
  for (const [badRules, message] of [
    [[], /缺少 ai-router/],
    [[{ ...rule, when: { ...rule.when, source: "other" } }], /source\.name/],
    [[{ ...rule, when: { ...rule.when, types: ["router.task.direct"] } }], /router\.task\.plan/],
    [[{ ...rule, to: "missing" }], /已登记的 Agent/],
    [[rule, { ...rule, name: "generic-event", when: { source: "workstation", types: ["*"] } }], /其他规则/],
    [[{ ...rule, parallel: 2 }], /parallel: 1/],
  ] as const) {
    await writeFile(disk, JSON.stringify({ ...rules, rules: badRules }));
    hubRuntime.reloadRules();
    const events = state().sources.find(({ id }) => id === "workstation")?.events;
    const response = await post("修改一个错字");
    assert.ok(response.status >= 400);
    assert.match((await response.json()).error, message);
    assert.equal(state().sources.find(({ id }) => id === "workstation")?.events, events);
  }
  await writeFile(disk, JSON.stringify(rules));
  hubRuntime.reloadRules();
});

test("a missing or differently configured live rule cannot pass disk validation", async () => {
  const activeFile = process.env.AGENT_AUTOLOOP_RULES!;
  const alternate = join(home, "console-rules.json");
  for (const active of [
    { ...rules, rules: [] },
    { ...rules, rules: [{ ...rule, parallel: 2 }] },
  ]) {
    await writeFile(activeFile, JSON.stringify(active));
    await writeFile(alternate, JSON.stringify(rules));
    hubRuntime.reloadRules();
    const seq = state().seq;
    process.env.AGENT_AUTOLOOP_RULES = alternate;
    try {
      const response = await post("修改一个错字");
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /中台.*生效/);
    } finally { process.env.AGENT_AUTOLOOP_RULES = activeFile; }
    assert.equal(state().seq, seq);
  }
  await writeFile(activeFile, JSON.stringify(rules));
  hubRuntime.reloadRules();
});

test("a Source key assigned to another source cannot create an event", async () => {
  const config = join(home, "config.json");
  const other = hubRuntime.addKey("source", "other");
  await writeFile(config, JSON.stringify({ url: hubUrl, owner, source: { name: "workstation", key: other } }));
  const seq = state().seq;
  try {
    const response = await post("修改一个错字");
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /凭据.*来源/);
    assert.equal(state().seq, seq);
  } finally {
    await writeFile(config, JSON.stringify({ url: hubUrl, owner, source: { name: "workstation", key: source } }));
  }
});

test("a guarded event with a stale rule revision is rejected without recording it", async () => {
  const { rulesRevision } = await hubClient(hubUrl, owner).state();
  const disk = process.env.AGENT_AUTOLOOP_RULES!;
  await writeFile(disk, JSON.stringify({ ...rules, rules: [] }));
  hubRuntime.reloadRules();
  const seq = state().seq;
  try {
    const result = await fetch(hubUrl + "/v1/events", {
      method: "POST", headers: { authorization: "Bearer " + source, "content-type": "application/json",
        "x-autoloop-source": "workstation", "x-autoloop-rules-revision": rulesRevision },
      body: JSON.stringify({ id: randomUUID(), type: "router.task.direct" }),
    });
    assert.equal(result.status, 409);
    assert.equal(state().seq, seq);
  } finally {
    await writeFile(disk, JSON.stringify(rules));
    hubRuntime.reloadRules();
  }
});

test("credentials cannot enter model inputs or leak through returned answers and errors", async () => {
  const before = modelCalls;
  assert.equal((await post("这段凭据 " + source)).status, 400);
  assert.equal(modelCalls, before);
  const reply = await (await post("检查模型回应")).text();
  assert.ok(reply.includes("[已隐藏]"));
  for (const value of [modelKey, source, owner]) assert.ok(!reply.includes(value));
  key = "";
  const error = await post("你好");
  assert.equal(error.status, 503);
  assert.match(await error.text(), /AUTOLOOP_ROUTER_API_KEY/);
});

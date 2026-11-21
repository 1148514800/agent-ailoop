// Requests with a local session must route through the real hub with separate event lanes and stable deduplication.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadHub } from "../server/hub.ts";
import { routerConfig } from "../server/router.ts";
import { parseRouterRules } from "../server/router-rule-config.ts";
import { rulesRevision } from "../agent-autoloop/protocol/rules.ts";
import { hubClient } from "../agent-autoloop/protocol/client.ts";

const home = await mkdtemp(join(tmpdir(), "autoloop-router-test-"));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
// Set the fixture paths before loading any module that can import the bundled host.
const { createConsole } = await import("../server/proxy.ts");
const { createRouter } = await import("../server/router-dispatch.ts");
const codexHome = join(home, "codex");
process.env.CODEX_HOME = codexHome;
await mkdir(codexHome);
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
  const [system, { content: message }] = JSON.parse(raw).messages;
  const useProfiles = system.content.includes("允许的执行档位：fast");
  const profile = message.includes("无权档位") ? "arbitrary-model" : message.includes("重构") ? "strong" : "fast";
  const named = message.startsWith("方案测试");
  const requirements = message.includes("研究") ? { type: "research", tools: [], complexity: "complex" }
    : message.includes("浏览器") ? { type: "operation", tools: ["browser_use"], complexity: "simple" }
      : { type: "coding", tools: [], complexity: "simple" };
  const decision = message === "你好" || message === "检查模型回应" ? {
    action: "reply", needs_plan: false, answer: message === "你好" ? "你好，有什么可以帮你？" : modelKey + " " + source,
  } : { action: "execute", needs_plan: message.includes("重构") || message.includes("简单但要规划"), answer: "",
    ...(useProfiles && { execution_profile: profile }), ...(named && { requirements }),
  };
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

test("model options expose only distinct visible model IDs from the local Codex cache", async () => {
  const endpoint = base + "/api/router/model-options";
  const fetchOptions = () => fetch(endpoint, { headers: { cookie } });
  assert.equal((await fetch(endpoint)).status, 401);
  assert.deepEqual(await (await fetchOptions()).json(), { models: [] });

  const file = join(codexHome, "models_cache.json");
  await writeFile(file, JSON.stringify({
    identity: { token: owner },
    models: [
      { visibility: "list", slug: "available-model", display_name: source },
      { visibility: "list", slug: "available-model" },
      { visibility: "hide", slug: "hidden-model" },
      { visibility: "list", slug: "--config" },
      { visibility: "list", slug: source },
      { visibility: "list", slug: "provider/other-model" },
    ],
  }));
  assert.deepEqual(await (await fetchOptions()).json(), { models: ["available-model", "provider/other-model"] });
  await writeFile(file, "{invalid");
  assert.deepEqual(await (await fetchOptions()).json(), { models: [] });
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

test("project discovery, dispatch and restart recovery preserve project and planning isolation", async () => {
  const added = { ...rule, name: "ai-project-game-box", cwd: join(home, "game-box"), when: {
    source: "workstation", types: ["router.project.game-box.direct", "router.project.game-box.plan"],
  }};
  await mkdir(added.cwd);
  const file = process.env.AGENT_AUTOLOOP_RULES!;
  const save = async (configured: typeof rules) => {
    await writeFile(file, JSON.stringify(configured));
    assert.deepEqual(hubRuntime.reloadRules(), {});
  };
  await save({ ...rules, rules: [rule, added] });
  const headers = { cookie, origin: base, "content-type": "application/json", "x-console-csrf": csrf };
  const projects = () => fetch(base + "/api/router/projects", { headers }).then(r => r.json());
  const submit = (body: object, path = "task", requestHeaders = headers) => fetch(base + "/api/router/" + path, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(body),
  });
  assert.equal((await fetch(base + "/api/router/projects")).status, 401);
  assert.deepEqual((await projects()).projects.map((project: { id: string; error?: string }) => [project.id, project.error]), [
    ["default", undefined], ["game-box", undefined],
  ]);

  const direct = { requestId: randomUUID(), projectId: "default", message: "检查默认项目", needsPlan: false };
  const plan = { requestId: randomUUID(), projectId: "game-box", message: "检查另一个项目", needsPlan: true };
  const before = modelCalls;
  assert.equal((await submit(plan, "task", { ...headers, "x-console-csrf": "" })).status, 403);
  const a = await (await submit(direct)).json();
  const b = await (await submit(plan)).json();
  assert.equal(a.status, "submitted", JSON.stringify(a));
  assert.equal(b.status, "submitted", JSON.stringify(b));
  assert.equal(a.run.state, "queued");
  assert.equal(b.run.state, "queued");
  assert.equal(modelCalls, before);
  assert.notEqual(a.run.id, b.run.id);
  assert.equal(key, "");

  const restarted = createRouter(options);
  const signal = new AbortController().signal;
  await rm(join(home, "router-requests", plan.requestId + ".event.json"));
  process.env.AGENT_AUTOLOOP_RULES = join(home, "unavailable.json");
  try { assert.deepEqual(await restarted(plan, signal, "direct"), b); }
  finally { process.env.AGENT_AUTOLOOP_RULES = file; }
  await assert.rejects(restarted({ ...plan, projectId: "default" }, signal, "direct"), { status: 409 });
  await assert.rejects(restarted({ ...plan, needsPlan: false }, signal, "direct"), { status: 409 });
  await assert.rejects(restarted({ requestId: plan.requestId, projectId: plan.projectId, message: plan.message }, signal), { status: 409 });

  key = modelKey;
  try {
    const eventCount = state().sources[0].events;
    const reply = await (await submit({ requestId: randomUUID(), projectId: "game-box", message: "你好" }, "message")).json();
    assert.equal(reply.action, "reply");
    assert.equal(state().sources[0].events, eventCount);
    const c = await (await submit({ requestId: randomUUID(), projectId: "game-box", message: "修改说明" }, "message")).json();
    assert.equal(c.status, "submitted", JSON.stringify(c));
    const worker = hubClient(hubUrl, hubRuntime.addKey("worker", "offline-worker"));
    for (const [result, cwd, type] of [
      [a, home, "router.task.direct"],
      [b, added.cwd, "router.project.game-box.plan"],
      [c, added.cwd, "router.project.game-box.direct"],
    ]) {
      const { job } = await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true });
      assert.equal(job.run, result.run.id);
      assert.equal(job.rule.cwd, cwd);
      assert.equal(job.context.events[0].type, type);
      await worker.result(job.run, job.token, { outcome: "done" });
    }
    const beforeFailures = state().sources[0].events;
    for (const patch of [{ projectId: "../game-box" }, { projectId: "missing" }, { cwd: home }, { needsPlan: "true" }]) {
      assert.ok((await submit({ ...plan, requestId: randomUUID(), ...patch })).status >= 400);
    }
    const invalidProjects: [typeof rule[], RegExp][] = [
      [[rule, { ...added, cwd: join(home, "missing") }], /工作目录/],
      [[{ ...rule, when: { ...rule.when, types: ["router.*"] } }, added], /其他规则/],
    ];
    for (const [badRules, error] of invalidProjects) {
      await save({ ...rules, rules: badRules });
      assert.match((await projects()).projects.find((project: { id: string }) => project.id === "game-box").error, error);
      assert.match((await (await submit({ ...plan, requestId: randomUUID() })).json()).error, error);
    }
    const stale = join(home, "stale.json");
    await writeFile(stale, JSON.stringify({ ...rules, rules: [rule, added] }));
    process.env.AGENT_AUTOLOOP_RULES = stale;
    try { assert.match((await (await submit({ ...plan, requestId: randomUUID() })).json()).error, /中台当前生效/); }
    finally { process.env.AGENT_AUTOLOOP_RULES = file; }
    assert.equal(state().sources[0].events, beforeFailures);
  } finally { await save(rules); }
});

test("web projects load into the Hub, execute through registered agents and retire without removing records", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "router-managed-projects-"));
  const directory = join(workspace, "existing");
  await mkdir(directory);
  const marker = join(directory, "keep.txt");
  await writeFile(marker, "保留工程");
  const file = process.env.AGENT_AUTOLOOP_RULES!;
  const original = await readFile(file, "utf8");
  const originalMode = (await stat(file)).mode & 0o777;
  const list = () => fetch(base + "/api/router/projects", { headers: { cookie } }).then(r => r.json());
  const headers = { cookie, origin: base, "content-type": "application/json", "x-console-csrf": csrf };
  const send = (path: string, body: object, requestHeaders = headers) => fetch(base + "/api/router/" + path, {
    method: "POST", headers: requestHeaders, body: JSON.stringify(body),
  });
  const create = { name: "Game Box 扩展", directory, agentId: "lab" };
  key = "";
  const before = modelCalls;
  try {
    const unauth = await fetch(base + "/api/router/project-options");
    assert.equal(unauth.status, 401);
    const choices = await fetch(base + "/api/router/project-options", { headers: { cookie } }).then(r => r.json());
    assert.deepEqual(choices.agents, [{ id: "lab", name: "试验" }]);
    assert.equal((await send("projects", create, { ...headers, "x-console-csrf": "" })).status, 403);
    assert.equal((await send("projects/remove", { projectId: "default" })).status, 400);
    for (const patch of [
      { directory: "relative" }, { directory: join(workspace, "missing") }, { directory: directory + "/../existing" },
      { agentId: "other" }, { name: " " },
    ]) assert.equal((await send("projects", { ...create, ...patch })).status, 400);
    const link = join(workspace, "system");
    await symlink(process.platform === "win32" ? process.env.SystemRoot! : "/etc", link, "junction");
    assert.equal((await send("projects", { ...create, directory: link })).status, 400);
    assert.equal(await readFile(file, "utf8"), original);

    const duplicate = { ...create, name: "并发项目" };
    const [made, other, also] = await Promise.all([
      send("projects", create), send("projects", duplicate), send("projects", duplicate),
    ]);
    assert.equal(made.status, 200, JSON.stringify(await made.clone().json()));
    assert.deepEqual([other.status, also.status].sort(), [200, 409]);
    const { projectId } = await made.json();
    assert.equal(projectId, "game-box");
    assert.equal((await send("projects", { ...create, name: "Game Box" })).status, 409);
    const current = await readFile(file, "utf8");
    const blob = JSON.parse(current);
    assert.deepEqual(blob.rules[0], JSON.parse(original).rules[0]);
    assert.equal(blob.rules.length, 3);
    const registered = blob.rules.find((rule: { name: string }) => rule.name === "ai-project-game-box");
    assert.equal(registered.cwd, await realpath(directory));
    assert.equal(registered.to, "lab");
    assert.equal(registered.when.source, "workstation");
    assert.equal((await stat(file)).mode & 0o777, originalMode);
    assert.equal(state().rulesRevision, rulesRevision(parseRouterRules(current)));
    assert.ok((await list()).projects.some((p: { id: string; name: string }) => p.id === projectId && p.name === create.name));

    const task = { requestId: randomUUID(), projectId, message: "检查新项目", needsPlan: false };
    const queued = await (await send("task", task)).json();
    assert.ok(queued.run && queued.run.state === "queued", JSON.stringify(queued));
    const remove = () => send("projects/remove", { projectId });
    assert.match((await (await remove()).json()).error, /1 个未完成任务/);
    const worker = hubClient(hubUrl, hubRuntime.addKey("worker", "offline-worker"));
    const claim = async () => (await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true })).job;
    const job = await claim();
    assert.equal(job.run, queued.run.id);
    assert.equal(job.rule.cwd, await realpath(directory));
    assert.match((await (await remove()).json()).error, /1 个未完成任务/);
    await worker.result(job.run, job.token, { outcome: "done", summary: "验收通过", ask: [
      { title: "确认", text: "继续吗", options: ["继续", "停止"] }
    ] });
    assert.match((await (await remove()).json()).error, /1 个待回答审批/);
    const ownerClient = hubClient(hubUrl, owner);
    const card = state().cards.find((card) => card.rule === registered.name)!;
    await ownerClient.answer(card.id, { choice: 0 });
    const follow = await claim();
    assert.equal(follow.rule.name, registered.name);
    await worker.result(follow.run, follow.token, { outcome: "done", later: [{
      key: "project-review", at: new Date(Date.now() + 3600_000).toISOString(), about: "稍后复查"
    }] });
    assert.match((await (await remove()).json()).error, /1 个待复查事项/);
    // Fire the review timer with the fixture clock.
    const future = Date.now() + 3601_000;
    hubRuntime.tick(future);
    const due = hubRuntime.execute("claimNext", ["offline-worker", randomUUID()], future + 1);
    assert.equal(due.rule.name, registered.name);
    hubRuntime.execute("finish", [due.run, due.token, { outcome: "done" }], future + 2);
    assert.equal((await remove()).status, 200);
    assert.ok(!(await list()).projects.some((p: { id: string }) => p.id === projectId));
    assert.equal(await readFile(file, "utf8"), current);
    assert.equal(await readFile(marker, "utf8"), "保留工程");
    assert.equal((await send("task", { ...task, requestId: randomUUID() })).status, 409);
    assert.equal((await (await send("task", task)).json()).run.id, job.run);
    assert.ok((await ownerClient.why(job.run)).length > 0);

    const manual = JSON.parse(current);
    manual.rules.push({ ...registered, name: "catch-other", when: { source: "workstation", types: ["router.project.conflict.*"] } });
    await writeFile(file, JSON.stringify(manual));
    assert.deepEqual(hubRuntime.reloadRules(), {});
    const overlap = await send("projects", { ...create, name: "Conflict" });
    assert.equal(overlap.status, 409);
    assert.match((await overlap.json()).error, /其他规则/);
    assert.equal((await send("projects/remove", { projectId: "catch-other" })).status, 409);
    const alternate = join(home, "unwatched-rules.json");
    await writeFile(alternate, JSON.stringify(manual));
    process.env.AGENT_AUTOLOOP_RULES = alternate;
    try {
      const unconfirmed = await send("projects", { ...create, name: "Reload Proof" });
      assert.equal(unconfirmed.status, 503);
      assert.match((await unconfirmed.json()).error, /已保存，但未能确认中台加载/);
      assert.ok(JSON.parse(await readFile(alternate, "utf8")).rules.some((r: { name: string }) => r.name === "ai-project-reload-proof"));
      assert.ok(!state().lines.some((r) => r.name === "ai-project-reload-proof"));
    } finally { process.env.AGENT_AUTOLOOP_RULES = file; }
    assert.equal(modelCalls, before);
  } finally {
    await writeFile(file, original);
    hubRuntime.reloadRules();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("versioned profiles reach the Worker with the selected model, effort and project directory", async () => {
  const disk = process.env.AGENT_AUTOLOOP_RULES!;
  const original = await readFile(disk, "utf8");
  const config = JSON.parse(original);
  const project = { ...rule, to: "profile-codex" };
  config.rules = [project];
  config.agents["profile-codex"] = { name: "Codex", use: "codex", worker: "profile-worker", access: "read", maxActive: 1 };
  await writeFile(disk, JSON.stringify(config));
  hubRuntime.reloadRules();
  const previousKey = key;
  key = "";
  const headers = { cookie, origin: base, "content-type": "application/json", "x-console-csrf": csrf };
  const api = (path: string, body?: object) => fetch(base + "/api/router/" + path, {
    headers, ...(body && { method: "POST", body: JSON.stringify(body) }),
  });
  const save = (profile: string, model: string, effort: string) => api("projects/profile", { projectId: "default", profile, model, effort });
  const dispatch = (executionProfile: string, needsPlan: boolean, requestId = randomUUID()) =>
    api("task", { projectId: "default", requestId, executionProfile, needsPlan, message: "验证执行参数" });
  try {
    const missing = await (await api("agent-models")).json();
    assert.equal(missing.agents["profile-codex"].model, null);
    assert.equal(missing.agents["profile-codex"].effort, null);
    assert.equal((await dispatch("fast", false)).status, 409);
    assert.equal((await dispatch("auto", false)).status, 400);
    assert.equal((await api("task", { projectId: "default", requestId: randomUUID(), executionProfile: null, needsPlan: false, message: "校验档位" })).status, 400);
    assert.equal((await save("fast", "--config", "low")).status, 400);
    assert.equal((await save("fast", "verified-fast", "turbo")).status, 400);
    assert.equal((await save("strong", "verified-strong", "high")).status, 200);
    assert.equal((await save("fast", "verified-fast", "low")).status, 200);
    const list = await (await api("projects")).json();
    assert.equal(list.projects[0].profiles.fast.model, "verified-fast");
    assert.equal(state().ruleExecutionOverrides, true);
    const current = await readFile(disk, "utf8");
    const overlapping = JSON.parse(current);
    overlapping.rules.push({ ...project, name: "profile-catch-all", when: { source: "workstation", types: ["router.profile.*"] } });
    await writeFile(disk, JSON.stringify(overlapping));
    hubRuntime.reloadRules();
    assert.equal((await save("fast", "verified-fast", "low")).status, 409);
    assert.equal((await dispatch("fast", false)).status, 409);
    await writeFile(disk, current);
    hubRuntime.reloadRules();

    const id = randomUUID();
    const calls = modelCalls;
    const fast = await (await dispatch("fast", true, id)).json();
    const strong = await (await dispatch("strong", false)).json();
    assert.equal(modelCalls, calls);
    assert.equal(fast.execution.model, "verified-fast");
    assert.equal(strong.execution.effort, "high");
    assert.equal((await dispatch("strong", true, id)).status, 409);
    assert.equal((await save("fast", "updated-fast", "medium")).status, 200);
    assert.deepEqual(JSON.parse(await readFile(disk, "utf8")).agents, config.agents);
    const retry = await createRouter(options)({ projectId: "default", requestId: id, executionProfile: "fast", needsPlan: true, message: "验证执行参数" }, new AbortController().signal, "direct");
    assert.deepEqual(retry, fast);
    const worker = hubClient(hubUrl, hubRuntime.addKey("worker", "profile-worker"));
    for (const [result, model, effort, suffix] of [[fast, "verified-fast", "low", ".plan"], [strong, "verified-strong", "high", ".direct"]]) {
      const { job } = await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true });
      assert.equal(job.run, result.run.id);
      assert.equal(job.agent.id, "profile-codex");
      assert.equal(job.agent.model, model);
      assert.equal(job.agent.effort, effort);
      assert.equal(job.agent.access, "read");
      assert.equal(job.rule.cwd, project.cwd);
      assert.ok(job.context.events[0].type.endsWith(suffix));
      if (result === fast) {
        const concurrent = await worker.work({ claim: randomUUID(), wait: 0, running: [job.run], capacity: true });
        assert.ok(!concurrent.job);
      }
      await worker.result(job.run, job.token, { outcome: "done" });
    }

    const queued = await (await dispatch("strong", true)).json();
    const ownerClient = hubClient(hubUrl, owner);
    await ownerClient.cancel(queued.run.id);
    assert.equal(state().runs.find(({ id }) => id === queued.run.id)?.state, "cancelled");
    assert.ok((await ownerClient.why(queued.run.id)).length > 0);

    key = modelKey;
    const auto = (message: string, executionProfile = "auto", requestId = randomUUID()) =>
      api("message", { projectId: "default", requestId, executionProfile, message });
    const beforeInvalid = state().seq;
    assert.equal((await auto("无权档位")).status, 502);
    assert.equal(state().seq, beforeInvalid);
    for (const [message, choice, expected, model, effort, plan] of [
      ["检查 README", "auto", "fast", "updated-fast", "medium", false],
      ["简单但要规划", "auto", "fast", "updated-fast", "medium", true],
      ["分析并重构模块", "auto", "strong", "verified-strong", "high", true],
      ["分析并重构模块", "fast", "fast", "updated-fast", "medium", true],
    ] as const) {
      const requestId = randomUUID();
      const before = modelCalls;
      const response = await auto(message, choice, requestId);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.execution_profile, expected);
      assert.equal(result.needs_plan, plan);
      assert.equal((await (await auto(message, choice, requestId)).json()).run.id, result.run.id);
      assert.equal(modelCalls, before + 1);
      const { job } = await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true });
      assert.equal(job.run, result.run.id);
      assert.equal(job.agent.model, model);
      assert.equal(job.agent.effort, effort);
      assert.equal(job.rule.cwd, project.cwd);
      if (expected !== "strong") {
        await worker.result(job.run, job.token, { outcome: "done" });
        continue;
      }
      await worker.result(job.run, job.token, { outcome: "failed", error: "临时错误" });
      assert.equal(state().runs.find(({ id }) => id === job.run)?.state, "queued");
      assert.equal((await save("strong", "new-strong", "xhigh")).status, 200);
      const deferred = state().runs.find(({ id }) => id === job.run)!;
      const retryTime = Date.parse(deferred.notBefore) + 100;
      const retried = hubRuntime.execute("claimNext", ["profile-worker", randomUUID()], retryTime);
      assert.equal(retried.run, job.run);
      assert.equal(retried.agent.model, model);
      assert.equal(retried.agent.effort, effort);
      assert.equal(retried.rule.cwd, project.cwd);
      hubRuntime.execute("finish", [retried.run, retried.token, { outcome: "done" }], retryTime + 1);
    }

    assert.equal((await save("fast", "", "")).status, 200);
    const inherited = await (await dispatch("fast", false)).json();
    const { job } = await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true });
    assert.equal(job.run, inherited.run.id);
    assert.equal(inherited.execution.model, null);
    assert.equal(inherited.execution.effort, null);
    assert.equal(job.agent.model, undefined);
    assert.equal(job.agent.effort, undefined);
    await worker.result(job.run, job.token, { outcome: "done" });
  } finally {
    key = previousKey;
    await writeFile(disk, original);
    hubRuntime.reloadRules();
  }
});

test("named plans bind each Run to the selected agent revision and reject unverified computer tools", async () => {
  const disk = process.env.AGENT_AUTOLOOP_RULES!;
  const config = JSON.parse(await readFile(disk, "utf8"));
  key = modelKey;
  config.agents["fixture-dsh"] = { name: "DSH", use: "dsh", worker: "plans-worker", access: "read" };
  config.agents["fixture-codex"] = { name: "Codex", use: "codex", worker: "plans-worker", access: "edit" };
  await writeFile(disk, JSON.stringify(config));
  assert.deepEqual(hubRuntime.reloadRules(), {});
  const headers = { cookie, origin: base, "content-type": "application/json", "x-console-csrf": csrf };
  const send = async (path: string, body: object) => {
    const response = await fetch(base + "/api/router/" + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, result: await response.json() };
  };
  const make = { id: "", name: "快速编程", agentId: "fixture-codex", model: "test-model", effort: "low",
    tasks: ["coding"], complexity: "simple", projects: ["default"], enabled: true, priority: 50 };
  const fast = await send("plans", make);
  assert.equal(fast.status, 200, fast.result.error);
  const research = { ...make, name: "深度研究", agentId: "fixture-dsh", model: "", effort: "",
    tasks: ["research"], complexity: "complex" };
  assert.equal((await send("plans", { ...research, model: "unsupported" })).status, 400);
  const deep = await send("plans", research);
  assert.equal(deep.status, 200, deep.result.error);

  const request = { requestId: randomUUID(), projectId: "default", executionProfile: "auto", message: "方案测试 编程" };
  const queued = await send("message", request);
  assert.equal(queued.status, 200, queued.result.error);
  assert.equal(queued.result.planName, make.name);
  const researchRun = await send("message", { ...request, requestId: randomUUID(), message: "方案测试 研究" });
  assert.equal(researchRun.status, 200, researchRun.result.error);
  assert.equal(researchRun.result.planName, research.name);
  const workerKey = hubRuntime.addKey("worker", "plans-worker");
  await writeFile(join(home, "config.json"), JSON.stringify({ url: hubUrl, owner, source: { name: "workstation", key: source },
    worker: { name: "plans-worker", key: workerKey } }));
  const custom = { ...research, name: "DSH 网关", model: "partner/model", effort: "high", tasks: ["general"],
    provider: { api: "openai-completions", baseURL: "https://gateway.invalid/v1", key: "test-provider-secret",
      thinkingFormat: "deepseek", effortValue: "max" } };
  const configured = await send("plans", custom);
  assert.equal(configured.status, 200, configured.result.error);
  const plans = await fetch(base + "/api/router/plans", { headers }).then((res) => res.text());
  assert.ok(!plans.includes(custom.provider.key));
  assert.ok(!(await readFile(disk, "utf8")).includes(custom.provider.key));
  const customTask = await send("task", { ...request, requestId: randomUUID(), needsPlan: false,
    executionProfile: "plan:" + configured.result.id, requirements: { type: "general", tools: [], complexity: "simple" } });
  assert.equal(customTask.status, 200, customTask.result.error);
  assert.equal(customTask.result.execution.model, custom.model);
  assert.equal((await send("plans", { ...custom, id: configured.result.id, provider: {
    ...custom.provider, key: "", baseURL: "https://different.invalid/v1",
  } })).status, 400);
  assert.equal((await send("plans", { ...custom, id: configured.result.id, effort: "low", provider: {
    ...custom.provider, key: "", effortValue: "",
  } })).status, 200);
  const count = state().runs.length;
  assert.equal((await send("message", { ...request, requestId: randomUUID(), message: "方案测试 操作浏览器" })).status, 409);
  assert.equal((await send("task", { ...request, requestId: randomUUID(), needsPlan: false,
    executionProfile: "plan:" + fast.result.id,
    requirements: { type: "coding", tools: ["desktop_use"], complexity: "simple" } })).status, 409);
  assert.equal((await send("plans/verify", { id: fast.result.id, runId: queued.result.run.id, tool: "browser_use" })).status, 409);
  assert.equal(state().runs.length, count);

  assert.equal((await send("plans", { ...make, id: fast.result.id, model: "another-model" })).status, 200);
  assert.equal((await send("plans", { ...research, id: deep.result.id, enabled: false })).status, 200);
  assert.equal((await send("message", request)).result.run.id, queued.result.run.id);
  const worker = hubClient(hubUrl, workerKey);
  const codex = (await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true })).job;
  assert.equal(codex.run, queued.result.run.id);
  assert.equal(codex.agent.id, "fixture-codex");
  assert.equal(codex.agent.model, "test-model");
  assert.equal(codex.agent.effort, "low");
  assert.equal(codex.agent.access, "edit");
  await worker.result(codex.run, codex.token, { outcome: "failed", error: "测试重试" });
  const dsh = (await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true })).job;
  assert.equal(dsh.run, researchRun.result.run.id);
  assert.equal(dsh.agent.id, "fixture-dsh");
  assert.equal(dsh.agent.model, undefined);
  assert.equal(dsh.agent.access, "read");
  await worker.result(dsh.run, dsh.token, { outcome: "done" });
  const legacyWorker = await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true });
  assert.equal(legacyWorker.job, null);
  const customWorkerJob = (await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true, providers: true })).job;
  assert.equal(customWorkerJob.run, customTask.result.run.id);
  assert.equal(customWorkerJob.agent.model, custom.model);
  assert.equal(customWorkerJob.agent.effort, "high");
  const providerFolder = join(home, "dsh-routes", customWorkerJob.agent.providerRef!);
  assert.ok((await readFile(join(providerFolder, "route.yml"), "utf8")).includes('"reasoningEffort": "high"'));
  assert.ok(!(await readFile(join(providerFolder, "route.yml"), "utf8")).includes(custom.provider.key));
  assert.equal((await stat(join(providerFolder, ".credentials.yaml"))).mode & 0o077, 0);
  await worker.result(customWorkerJob.run, customWorkerJob.token, { outcome: "done" });
  const now = Date.parse(state().runs.find((run) => run.id === codex.run)!.notBefore) + 10;
  const retry = hubRuntime.execute("claimNext", ["plans-worker", randomUUID()], now);
  assert.equal(retry.run, codex.run);
  assert.equal(retry.agent.model, "test-model");
  assert.equal(retry.agent.access, "edit");
  hubRuntime.execute("finish", [retry.run, retry.token, { outcome: "done" }], now + 1);

  await writeFile(join(home, "config.json"), JSON.stringify({ url: hubUrl, owner, source: { name: "workstation", key: source },
    worker: { name: "plans-worker", key: workerKey } }));
  const browserPlan = await send("plans", { ...make, name: "浏览器验证", tasks: ["operation"] });
  assert.equal(browserPlan.status, 200, browserPlan.result.error);
  const probe = await send("plans/probe", { id: browserPlan.result.id, projectId: "default", tool: "browser_use" });
  assert.equal(probe.status, 200, probe.result.error);
  const probeJob = (await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true })).job;
  assert.equal(probeJob.run, probe.result.run.id);
  const session = randomUUID();
  await worker.result(probeJob.run, probeJob.token, { outcome: "done", session, summary: "声称工具已用" });
  const verify = () => send("plans/verify", { id: browserPlan.result.id, runId: probeJob.run, tool: "browser_use" });
  assert.equal((await verify()).status, 409);
  const output = join(home, "worker", "runs", probeJob.run + "-1");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "stdout-1.log"), [
    { type: "thread.started", thread_id: session },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "playwright", tool: "browser_snapshot", status: "completed", result: { content: [] } } },
  ].map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(await verify(), { status: 200, result: { capabilities: ["browser_use"] } });
  const verifiedRun = await send("message", { ...request, requestId: randomUUID(), message: "方案测试 操作浏览器" });
  assert.equal(verifiedRun.result.planName, "浏览器验证");
  const browserJob = (await worker.work({ claim: randomUUID(), wait: 0, running: [], capacity: true })).job;
  assert.equal(browserJob.run, verifiedRun.result.run.id);
  await worker.result(browserJob.run, browserJob.token, { outcome: "done" });

});

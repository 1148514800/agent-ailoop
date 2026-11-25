import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function fixture(home) {
  const original = resolve(process.env.AUTOLOOP_SOURCE ?? join(import.meta.dirname, "../agent-autoloop"));
  const rulesFile = join(home, "rules.json");
  const secondProject = join(home, "game-box");
  await mkdir(secondProject);
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_RULES = rulesFile;
  const eventRule = (name, to, type) => ({ name, to, when: { source: "local", types: [type] }, cwd: home, prompt: "浏览器验收占位。", parallel: 5 });
  const cronRule = (name, to, cron) => ({ name, to, when: { cron }, cwd: home, prompt: "浏览器验收占位。" });
  await writeFile(rulesFile, JSON.stringify({
    timezone: "Asia/Shanghai",
    sources: { local: { name: "本地事件" } },
    agents: {
      codex: { name: "Codex", use: "codex", worker: "studio-mac" },
      "router-codex": { name: "项目 Codex", use: "codex", worker: "router-worker" },
      dsh: { name: "测试 DeepSeek Harness", use: "dsh", worker: "studio-mac" },
      claude: { name: "Claude Code", use: "claude", worker: "studio-mac" },
      router: { name: "Router 测试 Agent", use: "command", worker: "router-worker", command: ["node", "--version"] },
      runner: { name: "巡检脚本", use: "command", worker: "ops-runner", command: ["node", "-e", "process.exit(0)"] },
    },
    channels: { terminal: { name: "测试通道" } },
    rules: [
      eventRule("知识库同步", "codex", "docs.changed"),
      eventRule("客户反馈分流", "claude", "feedback.new"),
      eventRule("服务健康检查", "runner", "service.check"),
      { ...eventRule("ai-router", "router", "router.task.*"), parallel: 1 },
      { ...eventRule("ai-project-game-box", "router", "router.project.game-box.*"), cwd: secondProject, parallel: 1 },
      cronRule("每日运营简报", "claude", "0 9 * * *"),
      cronRule("项目周报", "codex", "0 10 * * 1"),
    ],
  }));
  const load = (path) => import(pathToFileURL(join(original, path)).href);
  const runtime = await load("host/runtime.ts");
  const owner = runtime.addKey("owner", "owner");
  const worker = runtime.addKey("worker", "studio-mac");
  const local = runtime.addKey("source", "local");
  const channel = runtime.addKey("channel", "terminal");
  const routerWorker = runtime.addKey("worker", "router-worker");
  const timer = (offset) => new Date(Date.now() + offset).toISOString();
  const historical = Date.now() - 3 * 86_400_000;
  for (let i = 1; i <= 63; i++) {
    const at = historical + (i * 41_000);
    runtime.execute("ingest", ["local", { id: "history-" + i, type: "docs.changed", subject: "doc-" + i, summary: "知识库例行同步" }], at);
    const job = runtime.execute("claimNext", ["studio-mac", "history-" + i], at + 200);
    assert.ok(job);
    runtime.execute("finish", [job.run, job.token, { outcome: "done", summary: "知识库索引已更新。", usage: { input: 900 + i * 12, output: 180, cached: 200, cost: 0.027 } }], at + 5000);
  }

  const { serve } = await load("host/http.ts");
  const hub = serve(0, "127.0.0.1", { commit: "fixture-local" });
  const streams = new Set();
  hub.on("request", (request, response) => {
    if (request.url?.startsWith("/v1/stream?")) {
      streams.add(response);
      response.once("close", () => streams.delete(response));
    }
  });
  const disconnect = () => { for (const stream of streams) stream.destroy(); };
  await once(hub, "listening");
  const url = "http://127.0.0.1:" + hub.address().port;
  await writeFile(join(home, "config.json"), JSON.stringify({ url, owner, worker: { name: "studio-mac", key: worker }, source: { name: "local", key: local } }), { mode: 0o600 });

  async function call(path, method = "GET", key = owner, body) {
    const res = await fetch(url + path, {
      method, headers: { authorization: "Bearer " + key, ...(body && { "content-type": "application/json" }) }, ...(body && { body: JSON.stringify(body) }),
    });
    const value = await res.json();
    assert.ok(res.ok, path + " " + res.status + " " + (value.error ?? ""));
    return value;
  }
  let serial = 0;
  const emit = (type, subject, summary) => call("/v1/events", "POST", local, { id: "test-" + (++serial), type, subject, summary });
  const claim = (running = [], key = worker, capacity = 1) => call("/v1/work?" + new URLSearchParams({ claim: "work-" + (++serial), wait: "0", running: running.join(","), capacity: String(capacity) }), "GET", key);
  const start = (job) => call(`/v1/runs/${job.run}/started`, "POST", job.token, { session: "fixture-session-" + job.run });
  const finish = (job, result) => call(`/v1/runs/${job.run}/result`, "POST", job.token, result);
  const state = () => call("/v1/state");

  await emit("feedback.new", "feedback-55", "运营限流策略需确认");
  const freeText = (await claim()).job;
  await start(freeText);
  await finish(freeText, { outcome: "done", summary: "已整理可选的处理范围。", usage: { input: 2130, output: 493 },
    ask: [{ title: "确认客户反馈的处理范围", text: "已归纳这一批反馈。请确认哪些分类应纳入后续处理。", options: ["仅处理阻塞问题", "处理全部已分类问题"] }] });
  await emit("docs.changed", "doc-ops", "导入索引后复查");
  const notice = (await claim()).job;
  await start(notice);
  await finish(notice, { outcome: "done", summary: "增量索引构建完成。", usage: { input: 8175, output: 734, cost: 0.96 },
    notice: [{ title: "知识库索引已更新", text: "本次导入包含 38 篇文档。请记录复核情况后结案。" }],
    later: [{ key: "verify", at: timer(41 * 60_000), about: "核对索引增量与源文档数" }] });
  await emit("feedback.new", "feedback-82", "拟定发布说明的发放范围");
  const ask = (await claim()).job;
  await start(ask);
  await finish(ask, { outcome: "done", summary: "发布说明已起草，等待确认分发范围。", usage: { input: 13250, output: 1286, cached: 2400, cost: 0.53 },
    ask: [{ title: "确认发布说明的分发范围", text: "项目更新说明已准备完毕，内容包括功能变更、已知问题和升级步骤。\n\n建议先在团队内部复核措辞，再决定对外发布时间。请选定本次分发范围。", options: ["仅发到内部测试频道", "同步给所有项目成员", "暂缓分发"], recommend: 0, about: "收到答复后，按所选分发范围继续。", key: "distribution" }] });
  await emit("docs.changed", "doc-api", "同步接口参考与示例");
  const running = (await claim()).job;
  await start(running);
  await emit("feedback.new", "feedback-91", "重复反馈待合并");
  const retrying = (await claim([running.run])).job;
  await start(retrying);
  await finish(retrying, { outcome: "failed", error: "反馈服务暂时不可用，将稍后重试。" });
  await emit("service.check", "status-edge", "边缘节点定期巡检");
  await emit("service.check", "status-db", "数据库连接检查");
  await call("/v1/cards/next?wait=0", "GET", channel);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const stopped = once(hub, "close");
    hub.close();
    hub.closeAllConnections();
    await stopped;
    runtime.db.close();
  };
  function exhaustRouter(id) {
    for (let attempt = 1; attempt < 10; attempt++) {
      const run = runtime.getView().get("runs", id);
      const at = Date.parse(run.not_before) + 1;
      const job = runtime.execute("claimNext", ["router-worker", "retry-" + attempt], at);
      assert.equal(job.run, id);
      runtime.execute("finish", [job.run, job.token, { outcome: "failed", error: "示例服务暂时无法连接" }], at + 1);
    }
  }
  return { url, emit, claim, finish, state, close, disconnect, running, exhaustRouter, claimRouter: () => claim([], routerWorker) };
}

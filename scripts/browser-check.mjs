import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { fixture } from "./fixture.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "autoloop-console-"));
const home = join(sandbox, "hub");
const codexHome = join(sandbox, "codex");
await mkdir(home);
await mkdir(codexHome);
await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
  models: [
    { slug: "browser-test-model", visibility: "list" },
    { slug: "other-test-model", visibility: "list" },
  ],
}));
const screenshots = process.env.AUTOLOOP_TEST_SCREENSHOTS || join(import.meta.dirname, "../docs/screenshots");
const shot = process.argv.includes("--screenshots");
const dshHome = join(sandbox, "dsh");
const dshProfile = join(dshHome, "profiles", "research_web");
await mkdir(dshProfile, { recursive: true });
await writeFile(join(dshProfile, "cordis.patch.yml"), JSON.stringify([{ id: "llm-pi-ai", config: { providers: {
  demo: { api: "openai-completions", baseURL: "https://example.invalid", apiKeyEnv: "DSH_DEMO_KEY", models: [
    { id: "demo-research", reasoningEfforts: { high: "max" } }, { id: "demo-fast" },
  ] },
  restricted: { api: "openai-completions", baseURL: "https://example.invalid", apiKeyEnv: "DSH_DEMO_KEY",
    headers: { Authorization: "browser-private-fixture" }, models: [{ id: "restricted-model" }] },
} } }]));
const webProfile = join(dshHome, "profiles", "web");
await mkdir(webProfile);
await writeFile(join(webProfile, "cordis.patch.yml"), JSON.stringify([{ id: "llm-pi-ai", config: { providers: {
  browser: { api: "openai-completions", baseURL: "https://example.invalid", apiKeyEnv: "DSH_DEMO_KEY", models: [{ id: "web-model" }] },
} } }]));
await writeFile(join(dshHome, ".credentials.yaml"), JSON.stringify({ version: 1, refs: { DSH_DEMO_KEY: "browser-fixture-secret" } }), { mode: 0o600 });
let hub, server, browser, model, probeServer;
const dispose = async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  await hub?.close();
  if (probeServer?.listening) {
    const stopped = once(probeServer, "close");
    probeServer.close();
    probeServer.closeAllConnections();
    await stopped;
  }
  if (model?.listening) {
    const stopped = once(model, "close");
    model.close();
    model.closeAllConnections();
    await stopped;
  }
  await rm(sandbox, { recursive: true, force: true });
};
process.once("SIGINT", () => void dispose().finally(() => process.exit(130)));
process.once("SIGTERM", () => void dispose().finally(() => process.exit(143)));

async function start() {
  server = spawn(process.execPath, ["server/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env, DSH_HOME: dshHome, CODEX_HOME: codexHome, AGENT_AUTOLOOP_HOME: home, AUTOLOOP_CONSOLE_PORT: "0", AUTOLOOP_HUB_URL: "",
      AUTOLOOP_ROUTER_ENABLED: "true", AUTOLOOP_ROUTER_BASE_URL: "http://127.0.0.1:" + model.address().port + "/v1",
      AUTOLOOP_ROUTER_API_KEY: "browser-mock-key", AUTOLOOP_ROUTER_MODEL: "fixture-model",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let lines = "";
    const child = server;
    const timeout = setTimeout(() => reject(new Error("控制台启动超时")), 10_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("控制台提前退出")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      lines += data;
      const url = lines.match(/本地控制台 (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) { clearTimeout(timeout); resolve(url); }
    });
  });
}

async function openConsole(page, address) {
  await page.goto(address);
  await page.getByRole("heading", { name: "运行总览" }).waitFor();
  await page.getByText("中台在线", { exact: true }).waitFor();
}
const capture = async (page, name) => {
  if (shot) await page.screenshot({ path: join(screenshots, name + ".png"), fullPage: true, animations: "disabled" });
};
const noOverflow = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

try {
  if (shot) await mkdir(screenshots, { recursive: true });
  hub = await fixture(home);
  model = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text).messages[1].content;
    const result = message === "你好"
      ? { action: "reply", needs_plan: false, answer: "你好，有什么可以帮你？" }
      : { action: "execute", needs_plan: message.includes("重构"), answer: "" };
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = await start();
  browser = await chromium.launch(process.env.AUTOLOOP_BROWSER_CHANNEL ? { channel: process.env.AUTOLOOP_BROWSER_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (/Content Security Policy/.test(entry.text())) errors.push(entry.text()); });
  await openConsole(page, address);
  await page.getByText("知识库同步", { exact: true }).first().waitFor();
  await page.getByText("中台在线", { exact: true }).waitFor();
  assert.equal(await page.getByText("1 轮缺失", { exact: true }).count(), 2);
  await noOverflow(page);
  await capture(page, "overview");

  const navigate = (name) => page.getByRole("navigation").getByRole("link", { name }).click();
  await navigate("审批中心");
  await page.getByRole("heading", { name: "确认发布说明的分发范围" }).waitFor();
  assert.ok(await page.getByRole("button", { name: "提交回复" }).isDisabled());
  await page.getByRole("radio", { name: /仅发到内部测试频道/ }).check();
  await capture(page, "approvals");
  await page.getByRole("button", { name: "提交回复" }).click();
  await page.getByText("答复已提交。", { exact: true }).waitFor();
  let state = await hub.state();
  assert.equal(state.recentCards.find((card) => card.title === "确认发布说明的分发范围").choice, 0);
  await page.getByRole("button", { name: "已处理", exact: true }).click();
  await page.getByRole("heading", { name: "确认发布说明的分发范围" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "提交回复" }).count(), 0);

  await page.getByRole("button", { name: /^待处理/ }).click();
  await page.getByRole("button", { name: /知识库索引已更新/ }).click();
  await page.getByLabel("处理结果").fill("已核对样本与导入记录。");
  await page.getByRole("button", { name: "确认结案" }).click();
  await page.getByText("通知已结案。", { exact: true }).waitFor();
  assert.equal((await hub.state()).recentCards.find((card) => card.title === "知识库索引已更新").state, "closed");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await mobile.newPage();
  await openConsole(phone, address);
  await phone.getByRole("button", { name: "打开导航" }).click();
  await phone.getByRole("navigation").getByRole("link", { name: "审批中心" }).click();
  await phone.getByRole("heading", { name: "确认客户反馈的处理范围" }).waitFor();
  await phone.getByRole("button", { name: "自定义文字" }).click();
  await phone.getByLabel("回复内容").fill("先处理阻塞类，其余确认后继续。");
  await noOverflow(phone);
  await capture(phone, "mobile-approval");
  await phone.getByRole("button", { name: "提交回复" }).click();
  await phone.getByText("答复已提交。", { exact: true }).waitFor();
  assert.equal((await hub.state()).recentCards.find((card) => card.title === "确认客户反馈的处理范围").answer, "先处理阻塞类，其余确认后继续。");
  await mobile.close();

  await navigate("任务轮次");
  const before = await page.locator(".run-table tbody tr").count();
  await page.getByRole("button", { name: "加载更早轮次" }).click();
  await page.getByText("已到历史记录末尾").waitFor();
  const after = await page.locator(".run-table tbody tr").count();
  assert.ok(after > before);
  const ids = await page.locator(".run-table .row-link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  assert.equal(new Set(ids).size, ids.length);
  await page.getByLabel("Agent", { exact: true }).selectOption("codex");
  await page.getByLabel("规则", { exact: true }).selectOption("知识库同步");
  await page.getByLabel("状态", { exact: true }).selectOption("claimed");
  await page.getByRole("link", { name: "查看第 " + hub.running.run + " 轮详情" }).click();
  await page.getByRole("heading", { name: "执行时间线" }).waitFor();
  await page.getByText("开始执行", { exact: true }).waitFor();
  await capture(page, "run-detail");
  await page.getByRole("button", { name: "停止任务" }).click();
  await page.getByRole("button", { name: "确认停止" }).click();
  await page.getByText("已请求停止，等待 Worker 确认。").waitFor();
  assert.ok((await hub.claim([hub.running.run], undefined, 0)).cancel.includes(hub.running.run));
  await hub.finish(hub.running, { outcome: "cancelled" });
  await page.locator(".drawer .badge").getByText("已停止", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭详情" }).click();

  await navigate("自动化规则");
  await page.getByRole("link", { name: /客户反馈分流/ }).click();
  await page.getByRole("button", { name: "暂停规则" }).click();
  await page.getByLabel("说明（可选）").fill("上游维护");
  await page.getByRole("button", { name: "确认暂停" }).click();
  await page.getByText("规则已暂停。").waitFor();
  assert.ok(await page.getByRole("button", { name: "立即运行" }).isDisabled());
  const skipped = await hub.emit("feedback.new", "feedback-new", "维护期间收到的新反馈");
  await page.getByText("维护期间收到的新反馈", { exact: true }).waitFor();
  await capture(page, "rules");
  await page.getByRole("button", { name: "恢复规则" }).click();
  await page.getByRole("button", { name: "确认恢复" }).click();
  await page.getByText("规则已恢复，有 1 条跳过的事件可补跑。").waitFor();
  await page.getByRole("button", { name: "补跑跳过事件" }).click();
  assert.match(await page.getByLabel("起始时间（带时区的 ISO 时间）").inputValue(), /Z$/);
  await page.getByRole("button", { name: "确认补跑" }).click();
  await page.getByText("已补跑 1 条事件，涉及 1 轮。").waitFor();
  assert.ok(skipped.event > 0);
  await page.getByRole("button", { name: "立即运行" }).click();
  await page.getByLabel("事件对象（可选）").fill("manual-check");
  await page.getByRole("button", { name: "确认运行" }).click();
  await page.getByText(/已提交，第 \d+ 轮。/).waitFor();
  assert.ok((await hub.state()).runs.some((run) => run.rule === "客户反馈分流" && run.manual));
  await page.getByRole("button", { name: "关闭详情" }).click();

  await navigate("事件动态");
  await page.getByText("实时连接", { exact: true }).waitFor();
  const seqBefore = (await hub.state()).seq;
  hub.disconnect();
  await page.getByText("正在连接", { exact: true }).waitFor();
  await hub.emit("service.check", "sse-gap", "断开期间收到的事件");
  await page.locator(".feed").getByText(/断开期间收到的事件/).waitFor();
  const seqAfter = (await hub.state()).seq;
  assert.ok(seqAfter > seqBefore);
  assert.equal(await page.locator(".feed").getByText("#" + seqAfter, { exact: true }).count(), 1);

  await navigate("运行总览");
  const routerPanel = page.locator(".router-panel");
  const sendRouter = async (message) => {
    await routerPanel.getByLabel("消息").fill(message);
    await routerPanel.getByRole("button", { name: "发送", exact: true }).click();
  };
  const project = routerPanel.getByLabel("目标项目");
  await project.getByRole("option", { name: /game-box/ }).waitFor({ state: "attached" });
  assert.equal(await project.inputValue(), "default");
  assert.ok(await routerPanel.getByRole("radio", { name: "AI 自动判断" }).isChecked());
  const originalRuns = (await hub.state()).runs.filter((run) => run.rule === "ai-router").length;
  await sendRouter("你好");
  await routerPanel.getByText("你好，有什么可以帮你？", { exact: true }).waitFor();
  assert.equal((await hub.state()).runs.filter((run) => run.rule === "ai-router").length, originalRuns);
  await sendRouter("帮我修改 README 中的错别字");
  await routerPanel.getByText("直接执行", { exact: true }).waitFor();
  await routerPanel.getByText("排队中", { exact: true }).waitFor();
  const simple = (await hub.claimRouter()).job;
  assert.equal(simple.context.events[0].type, "router.task.direct");
  assert.equal(simple.context.events[0].detail, "帮我修改 README 中的错别字");
  await routerPanel.getByText("执行中", { exact: true }).waitFor();
  await hub.finish(simple, { outcome: "done", summary: "README 错别字已修正。" });
  await routerPanel.getByText("README 错别字已修正。", { exact: true }).waitFor();
  await routerPanel.getByRole("link", { name: "查看第 " + simple.run + " 轮" }).click();
  await page.getByRole("heading", { name: "执行时间线" }).waitFor();
  await page.getByRole("button", { name: "关闭详情" }).click();
  await navigate("运行总览");
  await sendRouter("帮我重构调度模块并完成相关测试");
  await routerPanel.getByText("建议先规划", { exact: true }).waitFor();
  const plan = (await hub.claimRouter()).job;
  assert.equal(plan.context.events[0].type, "router.task.plan");
  await hub.finish(plan, { outcome: "done", summary: "规划验证完成。" });
  await project.selectOption("game-box");
  await routerPanel.getByRole("radio", { name: "直接创建任务" }).check();
  await routerPanel.getByRole("checkbox", { name: "先规划再执行" }).check();
  const taskInput = routerPanel.getByLabel("消息");
  const taskButton = routerPanel.getByRole("button", { name: "创建任务", exact: true });
  await taskInput.fill("校验第二个项目的任务");
  const taskRequest = (request) => request.url().endsWith("/api/router/task");
  await page.route("**/api/router/task", (route) => route.abort("failed"), { times: 1 });
  const firstAttempt = page.waitForRequest(taskRequest);
  await taskButton.click();
  const original = (await firstAttempt).postDataJSON();
  await taskButton.waitFor();
  assert.equal(await taskInput.inputValue(), original.message);
  const retry = page.waitForRequest(taskRequest);
  await taskButton.click();
  assert.deepEqual((await retry).postDataJSON(), original);
  await routerPanel.getByText("game-box · 直接创建任务", { exact: true }).waitFor();
  const direct = (await hub.claimRouter()).job;
  assert.equal(direct.rule.name, "ai-project-game-box");
  assert.equal(direct.context.events[0].type, "router.project.game-box.plan");
  assert.equal(direct.rule.cwd, join(home, "game-box"));
  await hub.finish(direct, { outcome: "done", summary: "第二个项目执行完成。" });
  await routerPanel.getByText("第二个项目执行完成。", { exact: true }).waitFor();

  const directory = join(sandbox, "managed 中文目录");
  await mkdir(directory);
  await routerPanel.getByRole("button", { name: "添加项目", exact: true }).click();
  const addProject = page.getByRole("dialog", { name: "添加项目" });
  await addProject.getByLabel("项目名称").fill("网页项目");
  const directoryInput = addProject.getByLabel("项目目录");
  const browseFolders = addProject.getByRole("button", { name: "浏览文件夹" });
  const pickerRoute = "**/api/router/projects/pick-folder";
  await directoryInput.fill(directory);
  await page.route(pickerRoute, (route) => route.fulfill({ status: 503, json: { error: "当前环境不支持原生文件夹选择。请手动输入绝对路径。" } }), { times: 1 });
  await browseFolders.click();
  await addProject.getByRole("alert").getByText(/手动输入绝对路径/).waitFor();
  assert.equal(await directoryInput.inputValue(), directory);
  await page.route(pickerRoute, (route) => route.fulfill({ json: { directory: null } }), { times: 1 });
  const cancelled = page.waitForResponse((res) => res.url().endsWith("/pick-folder"));
  await browseFolders.click();
  await cancelled;
  assert.equal(await directoryInput.inputValue(), directory);
  assert.equal(await addProject.getByRole("alert").count(), 0);
  const absoluteDirectory = await realpath(directory);
  await directoryInput.fill("");
  await page.route(pickerRoute, (route) => route.fulfill({ json: { directory: absoluteDirectory } }), { times: 1 });
  await browseFolders.click();
  await page.waitForFunction((expected) => document.querySelector("input[name=directory]")?.value === expected, absoluteDirectory);
  await addProject.getByLabel("执行 Agent").selectOption("router");
  await addProject.getByRole("button", { name: "保存项目" }).click();
  const registered = project.getByRole("option", { name: /网页项目/ });
  await registered.waitFor({ state: "attached" });
  assert.equal(await project.inputValue(), await registered.getAttribute("value"));
  await taskInput.fill("检查网页添加的项目");
  await taskButton.click();
  await routerPanel.getByText("网页项目 · 直接创建任务", { exact: true }).waitFor();
  await routerPanel.getByRole("button", { name: "移除项目", exact: true }).click();
  const removeProject = page.getByRole("dialog", { name: "移除项目" });
  await removeProject.getByText(/网页项目.*managed/).waitFor();
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await removeProject.getByRole("alert").getByText(/1 个未完成任务/).waitFor();
  const job = (await hub.claimRouter()).job;
  assert.equal(job.rule.cwd, absoluteDirectory);
  await hub.finish(job, { outcome: "done", summary: "网页项目执行完成。" });
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await registered.waitFor({ state: "detached" });
  assert.equal(await project.inputValue(), "default");

  await routerPanel.getByRole("button", { name: "添加项目", exact: true }).click();
  await addProject.getByLabel("项目名称").fill("模型档位项目");
  await directoryInput.fill(directory);
  await addProject.getByLabel("执行 Agent").selectOption("router-codex");
  await addProject.getByRole("button", { name: "保存项目" }).click();
  const tierProject = project.getByRole("option", { name: /模型档位项目/ });
  await tierProject.waitFor({ state: "attached" });
  const tier = routerPanel.getByLabel("执行档位");
  assert.equal(await tier.getByRole("option", { name: "Fast（未配置）" }).isDisabled(), true);
  const settings = routerPanel.getByRole("button", { name: "模型档位设置" });
  await settings.click();
  const profile = page.getByRole("dialog", { name: "模型档位设置" });
  const modelPicker = profile.getByLabel("模型 ID", { exact: true });
  assert.equal(await modelPicker.inputValue(), "");
  await modelPicker.getByRole("option", { name: "other-test-model" }).waitFor({ state: "attached" });
  await modelPicker.selectOption("browser-test-model");
  await profile.getByLabel("思考强度").selectOption("low");
  await profile.getByRole("button", { name: "保存档位" }).click();
  await routerPanel.getByText("Fast 档位已保存。", { exact: true }).waitFor();
  await settings.click();
  assert.equal(await modelPicker.inputValue(), "browser-test-model");
  await profile.getByLabel("设置档位").selectOption("strong");
  await modelPicker.selectOption({ label: "自定义模型 ID…" });
  await profile.getByLabel("自定义模型 ID", { exact: true }).fill("private-model");
  await profile.getByRole("button", { name: "保存档位" }).click();
  await routerPanel.getByText("Strong 档位已保存。", { exact: true }).waitFor();
  await settings.click();
  await profile.getByLabel("设置档位").selectOption("strong");
  assert.equal(await modelPicker.inputValue(), "private-model");
  await profile.getByRole("button", { name: "关闭" }).click();
  await tier.selectOption("fast");
  await routerPanel.getByText("browser-test-model", { exact: true }).waitFor();
  await taskInput.fill("验证 Fast 档位");
  await taskButton.click();
  await routerPanel.locator(".router-result").getByText("browser-test-model", { exact: true }).waitFor();
  await noOverflow(page);
  await capture(page, "router-model-profiles");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.setViewportSize(desktopViewport);
  await routerPanel.getByRole("button", { name: "移除项目", exact: true }).click();
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await removeProject.getByRole("alert").getByText(/1 个未完成任务/).waitFor();
  const profileJob = (await hub.claimRouter()).job;
  assert.equal(profileJob.agent.id, "router-codex");
  assert.equal(profileJob.agent.model, "browser-test-model");
  assert.equal(profileJob.agent.effort, "low");
  assert.equal(profileJob.rule.cwd, absoluteDirectory);
  await hub.finish(profileJob, { outcome: "done" });
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await tierProject.waitFor({ state: "detached" });

  await routerPanel.getByRole("button", { name: "执行方案", exact: true }).click();
  const plans = page.getByRole("dialog", { name: "执行方案" });
  await plans.getByLabel("方案名称").fill("本机研究模型");
  await plans.getByLabel("绑定 Agent").selectOption("dsh");
  await plans.getByLabel("DSH 供应商").selectOption("existing");
  const supplier = plans.getByLabel("本机供应商");
  await supplier.selectOption("web/browser");
  await plans.getByLabel("模型 ID", { exact: true }).getByRole("option", { name: "web-model" }).waitFor({ state: "attached" });
  await supplier.selectOption("research_web/restricted");
  await plans.getByText("供应商使用了自定义 HTTP 请求头，无法安全复用。").waitFor();
  assert.equal(await plans.getByLabel("模型 ID", { exact: true }).isDisabled(), true);
  assert.equal(await plans.getByText("browser-private-fixture").count(), 0);
  await supplier.selectOption("research_web/demo");
  await plans.getByLabel("模型 ID", { exact: true }).selectOption("demo-fast");
  assert.equal(await plans.getByLabel("思考强度").locator("option").count(), 1);
  await plans.getByLabel("模型 ID", { exact: true }).selectOption("demo-research");
  await plans.getByLabel("思考强度").selectOption("high");
  assert.equal(await plans.getByLabel("API Key", { exact: true }).count(), 0);
  await plans.getByRole("checkbox", { name: "研究", exact: true }).check();
  await plans.getByRole("checkbox", { name: /game-box/ }).first().check();
  await plans.getByRole("button", { name: "保存方案" }).click();
  await plans.getByText("执行方案已保存。").waitFor();
  await plans.getByRole("button", { name: "关闭" }).click();
  await routerPanel.getByRole("button", { name: "执行方案", exact: true }).click();
  await plans.getByLabel("选择方案").selectOption({ label: "本机研究模型" });
  assert.equal(await plans.getByLabel("本机供应商").inputValue(), "research_web/demo");
  assert.equal(await plans.getByLabel("模型 ID", { exact: true }).inputValue(), "demo-research");
  assert.equal(await plans.getByLabel("思考强度").inputValue(), "high");
  await noOverflow(page);
  await capture(page, "dsh-model-plan");
  await plans.getByRole("button", { name: "关闭" }).click();

  const { createConsole } = await import("../server/proxy.ts");
  const { browserProbe } = await import("../server/browser-proof.ts");
  probeServer = createConsole({ loadHub: async () => { throw new Error("test page requires no hub access"); } });
  await new Promise((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
  const proof = browserProbe("http://127.0.0.1:" + probeServer.address().port, randomUUID());
  const url = proof.message.match(/http:\/\/\S+?\/router-browser-check\/[a-f0-9]{32}/)?.[0];
  const token = proof.message.match(/输入 ([a-f0-9]{32})/)?.[1];
  assert.ok(url && token);
  const proofPage = await context.newPage();
  await proofPage.goto(url);
  await proofPage.getByLabel("验证文本").fill(token);
  await proofPage.getByRole("button", { name: "提交验证" }).click();
  await proofPage.getByRole("heading", { name: "验证成功" }).waitFor();
  await proofPage.close();

  await navigate("Agent");
  await page.getByRole("heading", { name: "已配置 Agent" }).waitFor();
  await page.getByRole("row", { name: /项目 Codex/ }).getByText("继承 Codex CLI 默认", { exact: true }).first().waitFor();
  assert.ok(await page.getByRole("row", { name: /巡检脚本.*离线/ }).count());
  await navigate("运行设置");
  await page.getByText("fixture-local", { exact: true }).waitFor();
  const dismiss = page.getByRole("button", { name: "关闭提示" });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole("button", { name: "切换浅色主题" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await noOverflow(page);
  await capture(page, "settings-light");
  await hub.close();
  await page.getByRole("button", { name: "刷新状态" }).click();
  await page.locator(".topbar").getByText("中台离线", { exact: true }).waitFor();
  await page.getByRole("alert").getByText(/当前显示.*快照/).waitFor();
  await context.clearCookies();
  const restored = page.waitForResponse((response) => response.url().endsWith("/api/session") && response.ok());
  await page.getByRole("button", { name: "刷新状态" }).click();
  await restored;
  await page.getByRole("heading", { name: "运行设置" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("通过。临时真实中台 + Chromium 验证了原有控制台流程、项目添加和移除、AI 自动判断、直接创建任务、Fast 档位设置、领取及移除保护、DSH 模型保存、隔离浏览器表单及断线重试。");
} finally { await dispose(); }

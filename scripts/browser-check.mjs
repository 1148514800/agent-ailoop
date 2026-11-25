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
  await page.getByRole("heading", { name: "今天想完成什么？" }).waitFor();
  await page.getByText("中台在线", { exact: true }).waitFor();
}
const capture = async (page, name) => {
  const representative = /^(router-(?:light-.+|dark-.+|mobile(?:-nav|-chain)?|history|approval|continued|chain-done|archived))$/;
  if (shot && representative.test(name)) await page.screenshot({ path: join(screenshots, "v0.4.5-" + name + ".png"), fullPage: true, animations: "disabled" });
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
      ? { action: "reply", needs_plan: false, answer: "你好，有什么可以帮你？\n\n| 项目 | 值 |\n| --- | --- |\n| 语法 | Markdown |\n\n```txt\n示例代码\n```\n\n<i data-test=unsafe>原始 HTML</i>\n\n```agent-autoloop\n{\"notice\":[\"内部回执占位\"]}\n```" }
      : { action: "execute", needs_plan: message.includes("重构"), answer: "" };
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = await start();
  browser = await chromium.launch(process.env.AUTOLOOP_BROWSER_CHANNEL ? { channel: process.env.AUTOLOOP_BROWSER_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (/Content Security Policy/.test(entry.text())) errors.push(entry.text()); });
  await openConsole(page, address);
  const navigate = (name) => page.getByRole("navigation").getByRole("link", { name }).click();
  const rail = page.getByRole("complementary", { name: "工作台侧栏" });
  const newTask = async () => {
    await rail.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByRole("heading", { name: "今天想完成什么？" }).waitFor();
  };
  const add = () => rail.getByRole("button", { name: "添加项目", exact: true }).click();
  const remove = async (name) => {
    await rail.getByRole("button", { name: "管理项目 " + name, exact: true }).click();
    await rail.getByRole("button", { name: "移除项目", exact: true }).click();
  };
  const routerPanel = page.locator(".router-panel");
  const project = routerPanel.getByLabel("目标项目");
  const mode = routerPanel.getByLabel("执行模式");
  const advanced = routerPanel.getByRole("button", { name: "高级选项", exact: true });
  const advancedButton = async (name) => {
    await advanced.click();
    await routerPanel.getByRole("button", { name, exact: true }).click();
  };
  const taskInput = routerPanel.getByLabel("消息");
  const taskButton = routerPanel.getByRole("button", { name: "发送", exact: true });
  await project.getByRole("option", { name: /game-box/ }).waitFor({ state: "attached" });
  assert.equal(await project.inputValue(), "default");
  assert.equal(await mode.inputValue(), "auto");
  assert.ok(await taskButton.isDisabled());
  await noOverflow(page);
  await capture(page, "router-dark-1440");
  await page.getByRole("button", { name: "折叠侧栏" }).click();
  assert.equal(await rail.isVisible(), false);
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await rail.getByRole("button", { name: "展开 game-box" }).click();
  await rail.getByRole("button", { name: "折叠 game-box" }).waitFor();
  await rail.getByRole("button", { name: "折叠 game-box" }).click();
  await page.getByRole("button", { name: "切换浅色主题" }).click();
  for (const [width, height] of [[1440, 900], [1920, 1080], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await noOverflow(page);
    await capture(page, "router-light-" + width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await navigate("运行总览");
  await page.getByText("知识库同步", { exact: true }).first().waitFor();
  await page.getByText("中台在线", { exact: true }).waitFor();
  assert.equal(await page.getByText("1 轮缺失", { exact: true }).count(), 2);
  await noOverflow(page);
  await capture(page, "overview");

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
  await noOverflow(phone);
  await capture(phone, "router-mobile");
  await phone.getByRole("button", { name: "打开导航" }).click();
  await capture(phone, "router-mobile-nav");
  await phone.getByRole("button", { name: "关闭导航" }).click({ position: { x: 325, y: 100 } });
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

  const previousToast = page.getByRole("button", { name: "关闭提示", exact: true });
  if (await previousToast.isVisible()) await previousToast.click();
  await newTask();
  const sendRouter = async (message) => {
    await taskInput.fill(message);
    await routerPanel.locator(".task-send:enabled").waitFor();
    await taskInput.press("Enter");
  };
  await project.getByRole("option", { name: /game-box/ }).waitFor({ state: "attached" });
  assert.equal(await project.inputValue(), "default");
  assert.equal(await mode.inputValue(), "auto");
  await taskInput.fill("第一行");
  await taskInput.press("Shift+Enter");
  assert.equal(await taskInput.inputValue(), "第一行\n");
  await taskInput.dispatchEvent("compositionstart");
  await taskInput.press("Enter");
  assert.ok(!(await taskInput.inputValue()).includes("你好"));
  assert.equal(await routerPanel.getByText(/正在判断任务/).count(), 0);
  await taskInput.dispatchEvent("compositionend");
  const originalRuns = (await hub.state()).runs.filter((run) => run.rule === "ai-router").length;
  await sendRouter("你好");
  await routerPanel.getByText("你好，有什么可以帮你？", { exact: true }).waitFor();
  assert.equal((await hub.state()).runs.filter((run) => run.rule === "ai-router").length, originalRuns);
  assert.equal(await routerPanel.locator(".task-markdown table").count(), 1);
  assert.equal((await routerPanel.locator(".task-markdown pre").innerText()).trim(), "示例代码");
  assert.equal(await routerPanel.locator("[data-test=unsafe]").count(), 0);
  assert.equal(await routerPanel.getByText("内部回执占位", { exact: false }).count(), 0);
  await capture(page, "router-chat");
  await sendRouter("帮我修改 README 中的错别字");
  await routerPanel.getByText("排队中", { exact: true }).waitFor();
  const simple = (await hub.claimRouter()).job;
  assert.equal(simple.context.events[0].type, "router.task.direct");
  assert.equal(simple.context.events[0].detail, "帮我修改 README 中的错别字");
  await routerPanel.getByText("执行中", { exact: true }).waitFor();
  await capture(page, "router-running");
  await hub.finish(simple, { outcome: "done", summary: "README 错别字已修正。" });
  await routerPanel.locator(".task-response").getByText("README 错别字已修正。", { exact: true }).waitFor();
  await noOverflow(page);
  await capture(page, "router-completed");
  await routerPanel.getByRole("link", { name: "查看执行详情" }).click();
  await page.getByRole("heading", { name: "执行时间线" }).waitFor();
  await page.getByRole("button", { name: "关闭详情" }).click();
  await newTask();
  await rail.getByRole("button", { name: "搜索任务" }).click();
  const search = rail.getByRole("textbox", { name: "搜索已加载任务" });
  await search.fill("Run #" + simple.run);
  const oldTask = rail.getByRole("link", { name: /修改 README 中的错别字/ });
  await oldTask.click();
  await page.reload();
  await routerPanel.getByRole("heading", { name: "帮我修改 README 中的错别字" }).waitFor();
  await routerPanel.locator(".task-response").getByText("README 错别字已修正。", { exact: true }).waitFor();
  await capture(page, "router-history");
  await newTask();
  await sendRouter("帮我重构调度模块并完成相关测试");
  await routerPanel.getByText("先规划再执行", { exact: true }).waitFor();
  const plan = (await hub.claimRouter()).job;
  assert.equal(plan.context.events[0].type, "router.task.plan");
  await hub.finish(plan, { outcome: "done", summary: "规划验证完成。", ask: [{ title: "确认规划范围", text: "请选择测试范围。", options: ["继续", "结束"] }] });
  await routerPanel.getByRole("link", { name: /等待审批 · 确认规划范围/ }).waitFor();
  await capture(page, "router-approval");
  const rootTask = "#router/" + plan.run;
  await routerPanel.getByRole("link", { name: /等待审批 · 确认规划范围/ }).click();
  await page.getByRole("radio", { name: "继续", exact: true }).check();
  await page.getByRole("button", { name: "提交回复" }).click();
  await page.getByText("答复已提交。", { exact: true }).waitFor();
  await page.evaluate((hash) => { location.hash = hash; }, rootTask);
  await routerPanel.getByText(/审批已处理 · 等待后续任务/).waitFor();
  const follow = (await hub.claimRouter()).job;
  assert.notEqual(follow.run, plan.run);
  assert.equal(follow.context.events[0].type, "card.answered");
  await routerPanel.getByText("审批后继续执行", { exact: true }).waitFor();
  await routerPanel.locator(".task-stages summary").click();
  await capture(page, "router-continued");
  await hub.finish(follow, { outcome: "done", summary: "初步处理，不是最终摘要。", ask: [
    { title: "确认发布步骤", text: "第二次审批。", options: ["继续", "结束"] },
    { title: "确认核对步骤", text: "另一条分支。", options: ["继续", "结束"] },
  ] });
  await routerPanel.getByRole("link", { name: /等待审批 · 确认发布步骤/ }).waitFor();
  await hub.asFeishu("确认发布步骤");
  const publish = (await hub.claimRouter()).job;
  assert.equal(publish.context.events.length, 1);
  await hub.finish(publish, { outcome: "done", summary: "发布分支已完成。" });
  await routerPanel.getByRole("link", { name: /等待审批 · 确认核对步骤/ }).waitFor();
  assert.equal(await routerPanel.getByRole("heading", { name: /任务摘要/ }).count(), 0);
  await hub.asFeishu("确认核对步骤");
  const verify = (await hub.claimRouter()).job;
  assert.notEqual(verify.run, publish.run);
  await hub.finish(verify, { outcome: "failed", error: "分支暂时失败" });
  await routerPanel.getByText("等待重试", { exact: true }).waitFor();
  assert.equal(await routerPanel.getByRole("heading", { name: /任务摘要/ }).count(), 0);
  const recovered = hub.claimRetry(verify.run);
  await hub.finish(recovered, { outcome: "done", summary: "核对分支重试后完成。" });
  await routerPanel.getByRole("heading", { name: "任务摘要 · Run #" + verify.run }).waitFor();
  await page.reload();
  assert.equal(new URL(page.url()).hash, rootTask);
  await routerPanel.getByRole("heading", { name: "任务摘要 · Run #" + publish.run }).waitFor();
  await routerPanel.locator(".task-response").getByText("核对分支重试后完成。", { exact: true }).waitFor();
  await capture(page, "router-chain-done");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await capture(page, "router-mobile-chain");
  await page.setViewportSize({ width: 1440, height: 900 });

  await newTask();
  await sendRouter("验证审批后取消分支");
  await routerPanel.getByText("排队中", { exact: true }).waitFor();
  const cancelRoot = (await hub.claimRouter()).job;
  await hub.finish(cancelRoot, { outcome: "done", summary: "初始摘要不可当作最终结果。", ask: [
    { title: "批准取消测试", text: "将取消后续轮次。", options: ["继续", "结束"] },
  ] });
  await routerPanel.getByRole("link", { name: /等待审批 · 批准取消测试/ }).waitFor();
  await hub.asFeishu("批准取消测试");
  const stopped = (await hub.claimRouter()).job;
  await hub.cancel(stopped);
  await hub.finish(stopped, { outcome: "cancelled" });
  await routerPanel.getByText("已取消", { exact: true }).waitFor();
  assert.equal(await routerPanel.getByRole("heading", { name: /任务摘要/ }).count(), 0);
  await newTask();
  await project.selectOption("game-box");
  await page.reload();
  await project.getByRole("option", { name: "game-box" }).waitFor({ state: "attached" });
  assert.equal(await project.inputValue(), "game-box");
  await mode.selectOption("direct");
  await advanced.click();
  await routerPanel.getByRole("checkbox", { name: "先规划再执行" }).check();
  await capture(page, "router-advanced");
  await page.setViewportSize({ width: 1280, height: 800 });
  await noOverflow(page);
  const popup = await page.locator(".advanced-panel").boundingBox();
  assert.ok(popup && popup.y >= 0 && popup.x + popup.width <= 1280 && popup.y + popup.height <= 800);
  await page.setViewportSize({ width: 1440, height: 900 });
  await advanced.click();
  await taskInput.fill("校验第二个项目的任务");
  const taskRequest = (request) => request.url().endsWith("/api/router/task");
  await page.route("**/api/router/task", (route) => route.abort("failed"), { times: 1 });
  const firstAttempt = page.waitForRequest(taskRequest);
  await taskButton.click();
  const original = (await firstAttempt).postDataJSON();
  await routerPanel.getByRole("alert").waitFor();
  assert.equal(await taskInput.inputValue(), original.message);
  await taskInput.fill("结果未确认时不自动提交另一请求");
  await taskButton.click();
  await routerPanel.getByRole("alert").getByText(/请保留原内容、项目和执行方案重试/).waitFor();
  await taskInput.fill(original.message);
  const retry = page.waitForRequest(taskRequest);
  await taskButton.click();
  assert.deepEqual((await retry).postDataJSON(), original);
  await routerPanel.getByText(/game-box · Run #/).waitFor();
  const direct = (await hub.claimRouter()).job;
  assert.equal(direct.rule.name, "ai-project-game-box");
  assert.equal(direct.context.events[0].type, "router.project.game-box.plan");
  assert.equal(direct.rule.cwd, join(home, "game-box"));
  await hub.finish(direct, { outcome: "done", summary: "第二个项目执行完成。" });
  await routerPanel.locator(".task-response").getByText("第二个项目执行完成。", { exact: true }).waitFor();
  const historyTarget = routerPanel.getByLabel("下一项任务的项目");
  await historyTarget.selectOption("default");
  assert.equal(await historyTarget.inputValue(), "default");
  await page.evaluate((id) => { location.hash = "#router/" + id; }, simple.run);
  const delayedDirect = "**/api/runs/" + direct.run + "/why?view=router-chain";
  let allowHistory;
  const historyRelease = new Promise((resolve) => { allowHistory = resolve; });
  await page.route(delayedDirect, async (route) => {
    const reply = await route.fetch();
    await historyRelease;
    await route.fulfill({ response: reply }).catch(() => {});
  }, { times: 1 });
  const oldRead = page.waitForRequest((request) => request.url().endsWith("/" + direct.run + "/why?view=router-chain"));
  await page.evaluate((id) => { location.hash = "#router/" + id; }, direct.run);
  await oldRead;
  await page.evaluate((id) => { location.hash = "#router/" + id; }, simple.run);
  await routerPanel.getByRole("heading", { name: "帮我修改 README 中的错别字" }).waitFor();
  allowHistory();
  assert.equal(await historyTarget.inputValue(), "default");
  await page.evaluate((id) => { location.hash = "#router/" + id; }, direct.run);
  await routerPanel.locator(".task-response").getByText("第二个项目执行完成。", { exact: true }).waitFor();
  assert.equal(await historyTarget.inputValue(), "game-box");
  assert.equal(await rail.getByRole("button", { name: "game-box", exact: true }).getAttribute("aria-pressed"), "true");
  await page.goBack();
  await routerPanel.getByRole("heading", { name: "帮我修改 README 中的错别字" }).waitFor();
  assert.equal(await historyTarget.inputValue(), "default");
  await page.goForward();
  await routerPanel.locator(".task-response").getByText("第二个项目执行完成。", { exact: true }).waitFor();
  assert.equal(await historyTarget.inputValue(), "game-box");
  await page.reload();
  await routerPanel.locator(".task-response").getByText("第二个项目执行完成。", { exact: true }).waitFor();
  assert.equal(await historyTarget.inputValue(), "game-box");
  await mode.selectOption("direct");

  await taskInput.fill("验证执行错误与重试");
  await taskButton.click();
  await routerPanel.getByText("排队中", { exact: true }).waitFor();
  const retryJob = (await hub.claimRouter()).job;
  await hub.finish(retryJob, { outcome: "failed", error: "示例服务暂时无法连接。" });
  await routerPanel.getByText("等待重试", { exact: true }).waitFor();
  await routerPanel.getByRole("alert").getByText("示例服务暂时无法连接").waitFor();
  await capture(page, "router-retry");
  hub.exhaustRouter(retryJob.run);
  await routerPanel.getByText("执行失败", { exact: true }).waitFor();
  await capture(page, "router-failed");

  const directory = join(sandbox, "managed 中文目录");
  await mkdir(directory);
  await add();
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
  await mode.selectOption("direct");
  await taskInput.fill("检查网页添加的项目");
  await taskButton.click();
  await routerPanel.getByText(/网页项目 · Run #/).waitFor();
  await remove("网页项目");
  const removeProject = page.getByRole("dialog", { name: "移除项目" });
  await removeProject.getByText(/网页项目.*managed/).waitFor();
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await removeProject.getByRole("alert").getByText(/1 个未完成任务/).waitFor();
  const job = (await hub.claimRouter()).job;
  assert.equal(job.rule.cwd, absoluteDirectory);
  await hub.finish(job, { outcome: "done", summary: "网页项目执行完成。" });
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await removeProject.waitFor({ state: "detached" });
  await newTask();
  await registered.waitFor({ state: "detached" });
  assert.equal(await project.inputValue(), "default");
  await rail.getByText("历史项目", { exact: true }).click();
  await rail.getByRole("link", { name: /检查网页添加的项目/ }).click();
  await routerPanel.getByText(/历史项目（已移除或目录已变更）/).waitFor();
  assert.equal(await historyTarget.inputValue(), "");
  await taskInput.fill("确认选择前不能提交");
  assert.equal(await taskButton.isDisabled(), true);
  await capture(page, "router-archived");
  await historyTarget.selectOption("default");
  assert.equal(await taskButton.isEnabled(), true);
  await newTask();

  await add();
  await addProject.getByLabel("项目名称").fill("模型档位项目");
  await directoryInput.fill(directory);
  await addProject.getByLabel("执行 Agent").selectOption("router-codex");
  await addProject.getByRole("button", { name: "保存项目" }).click();
  const tierProject = project.getByRole("option", { name: /模型档位项目/ });
  await tierProject.waitFor({ state: "attached" });
  const tier = routerPanel.getByLabel("执行方案", { exact: true });
  assert.equal(await tier.getByRole("option", { name: "Fast（未配置）" }).isDisabled(), true);
  const settings = () => advancedButton("模型档位设置");
  await settings();
  const profile = page.getByRole("dialog", { name: "模型档位设置" });
  const modelPicker = profile.getByLabel("模型 ID", { exact: true });
  assert.equal(await modelPicker.inputValue(), "");
  await modelPicker.getByRole("option", { name: "other-test-model" }).waitFor({ state: "attached" });
  await modelPicker.selectOption("browser-test-model");
  await profile.getByLabel("思考强度").selectOption("low");
  await profile.getByRole("button", { name: "保存档位" }).click();
  await routerPanel.getByText("Fast 档位已保存。", { exact: true }).waitFor();
  await settings();
  assert.equal(await modelPicker.inputValue(), "browser-test-model");
  await profile.getByLabel("设置档位").selectOption("strong");
  await modelPicker.selectOption({ label: "自定义模型 ID…" });
  await profile.getByLabel("自定义模型 ID", { exact: true }).fill("private-model");
  await profile.getByRole("button", { name: "保存档位" }).click();
  await routerPanel.getByText("Strong 档位已保存。", { exact: true }).waitFor();
  await settings();
  await profile.getByLabel("设置档位").selectOption("strong");
  await modelPicker.getByRole("option", { name: "other-test-model" }).waitFor({ state: "attached" });
  assert.equal(await modelPicker.inputValue(), "private-model");
  await capture(page, "router-model-dialog");
  await profile.getByRole("button", { name: "关闭" }).click();
  await mode.selectOption("direct");
  await tier.selectOption("fast");
  await page.evaluate((id) => { location.hash = "#router/" + id; }, direct.run);
  await historyTarget.getByRole("option", { name: "game-box" }).waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector('select[aria-label="下一项任务的项目"]')?.value === "game-box");
  assert.equal(await tier.inputValue(), "default");
  await newTask();
  await project.selectOption(await tierProject.getAttribute("value"));
  await mode.selectOption("direct");
  await tier.selectOption("fast");
  await advanced.click();
  await routerPanel.getByText("browser-test-model", { exact: true }).waitFor();
  await advanced.click();
  await taskInput.fill("验证 Fast 档位");
  await taskButton.click();
  await routerPanel.locator(".router-result").getByText(/browser-test-model/).first().waitFor();
  await noOverflow(page);
  await capture(page, "router-model-profiles");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.setViewportSize(desktopViewport);
  await remove("模型档位项目");
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await removeProject.getByRole("alert").getByText(/1 个未完成任务/).waitFor();
  const profileJob = (await hub.claimRouter()).job;
  assert.equal(profileJob.agent.id, "router-codex");
  assert.equal(profileJob.agent.model, "browser-test-model");
  assert.equal(profileJob.agent.effort, "low");
  assert.equal(profileJob.rule.cwd, absoluteDirectory);
  await hub.finish(profileJob, { outcome: "done" });
  await removeProject.getByRole("button", { name: "确认移除" }).click();
  await removeProject.waitFor({ state: "detached" });
  await newTask();
  await tierProject.waitFor({ state: "detached" });

  await advancedButton("执行方案");
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
  await advancedButton("执行方案");
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
  const sidebarPage = page.waitForResponse((response) => response.url().includes("/api/state?before=") && response.ok());
  await rail.getByRole("button", { name: "加载更早任务", exact: true }).click();
  assert.ok((await (await sidebarPage).json()).runs.length > 0);
  await navigate("运行设置");
  const feishuPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "飞书", exact: true }) });
  await feishuPanel.getByText("未启用", { exact: true }).waitFor();
  await feishuPanel.getByText(/^(在线|离线)$/).waitFor();
  await page.getByText("fixture-local", { exact: true }).waitFor();
  const dismiss = page.getByRole("button", { name: "关闭提示" });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole("button", { name: "切换浅色主题" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await noOverflow(page);
  await capture(page, "settings-light");
  const recovery = await context.newPage();
  recovery.setDefaultTimeout(12_000);
  await recovery.goto(address + "#router/" + direct.run);
  const recoveryRouter = recovery.locator(".router-panel");
  await recoveryRouter.locator(".task-response").getByText("第二个项目执行完成。", { exact: true }).waitFor();
  const recoveryInput = recoveryRouter.getByLabel("消息");
  await recoveryInput.fill("尚未提交的草稿");
  const oldSnapshot = await recovery.evaluate(() => fetch("/api/state").then((res) => res.json()));
  const replacement = { ...oldSnapshot, seq: 0, runs: [], nextBefore: null, hasMore: false };
  const chainPattern = "**/api/runs/" + direct.run + "/why?view=router-chain";
  let oldChainResponse;
  const heldChain = new Promise((resolve) => { oldChainResponse = resolve; });
  let replacedHub = false;
  let holdReads = false;
  await recovery.route(chainPattern, async (route) => {
    if (!replacedHub && holdReads) {
      const response = await route.fetch();
      await heldChain;
      await route.fulfill({ response }).catch(() => {});
      return;
    }
    if (replacedHub) return route.fulfill({ status: 404, json: { error: "没有这一轮" } });
    return route.continue();
  });
  await recovery.route("**/api/state", async (route) => {
    if (replacedHub) return route.fulfill({ json: replacement });
    if (holdReads) return route.fulfill({ json: { ...oldSnapshot, seq: oldSnapshot.seq + 1 } });
    return route.continue();
  });
  holdReads = true;
  const delayedRead = recovery.waitForRequest((request) => request.url().endsWith("/" + direct.run + "/why?view=router-chain"));
  await recovery.getByRole("button", { name: "刷新状态" }).click();
  await delayedRead;
  replacedHub = true;
  await recovery.getByRole("button", { name: "刷新状态" }).click();
  await recoveryRouter.getByText(/当前中台没有这个 Run/).waitFor();
  oldChainResponse();
  assert.equal(await recoveryInput.inputValue(), "尚未提交的草稿");
  assert.equal(await recoveryRouter.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);

  await recovery.unroute(chainPattern);
  const liveChain = await recovery.evaluate((id) => fetch("/api/runs/" + id + "/why?view=router-chain").then((res) => res.json()), direct.run);
  liveChain.history.message = "新数据实例中的同编号任务";
  liveChain.history.projectScope = "f".repeat(64);
  await recovery.route(chainPattern, (route) => route.fulfill({ json: liveChain }));
  replacement.seq = 1;
  await recovery.getByRole("button", { name: "刷新状态" }).click();
  await recoveryRouter.getByRole("heading", { name: "新数据实例中的同编号任务" }).waitFor();
  assert.equal(await recoveryRouter.getByLabel("下一项任务的项目").inputValue(), "");
  await recoveryRouter.getByLabel("下一项任务的项目").selectOption("default");
  await recoveryRouter.getByLabel("执行模式").selectOption("direct");
  let releaseSubmit;
  const heldSubmit = new Promise((resolve) => { releaseSubmit = resolve; });
  let submits = 0;
  await recovery.route("**/api/router/task", async (route) => {
    submits++;
    await heldSubmit;
    await route.fulfill({ json: { action: "execute", status: "submitted", run: { id: 999, state: "queued" } } }).catch(() => {});
  });
  const posting = recovery.waitForRequest(taskRequest);
  await recoveryRouter.getByRole("button", { name: "发送", exact: true }).click();
  const submittedId = (await posting).postDataJSON().requestId;
  replacement.hubIdentity = "replacement-instance";
  await recovery.getByRole("button", { name: "刷新状态" }).click();
  await recoveryRouter.getByText(/原提交结果未知/).waitFor();
  releaseSubmit();
  await recoveryInput.press("Enter");
  assert.equal(submits, 1);
  assert.equal(typeof submittedId, "string");
  assert.equal(await recoveryInput.inputValue(), "尚未提交的草稿");
  assert.equal(new URL(recovery.url()).hash, "#router/" + direct.run);
  await recovery.close();

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
  console.log("通过。Chromium + 临时真实中台验证项目绑定、审批分支、重试与取消、代次恢复和原有控制台流程。");
} finally { await dispose(); }

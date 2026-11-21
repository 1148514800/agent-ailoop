import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Run } from "../shared/types.ts";
import { dataHome } from "./router-rule-config.ts";
import { RouterError } from "./router.ts";

type Challenge = { url: string; input: string; result: string; submitted: boolean; expires: number };
const challenges = new Map<string, Challenge>();
const marker = "方案浏览器交互验证 ";
const random = () => randomBytes(16).toString("hex");

export function browserProbe(origin: string, requestId: string) {
  for (const [id, item] of challenges) if (item.expires <= Date.now()) challenges.delete(id);
  if (challenges.size >= 64) throw new RouterError(429, "本机验证轮次过多，请稍后重试。");
  const path = "/router-browser-check/" + random();
  const item = { url: origin + path, input: random(), result: random(), submitted: false, expires: Date.now() + 30 * 60_000 };
  challenges.set(path, item);
  return {
    message: "仅在隔离测试页验证浏览器交互。用 Playwright MCP 打开 " + item.url +
      "。向「验证文本」输入 " + item.input +
      "，点击「提交验证」，再用浏览器快照核对页面显示「验证成功」。只访问这个本机测试页面。",
    summary: marker + requestId + " " + path,
  };
}

export async function serveBrowserCheck(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!url.pathname.startsWith("/router-browser-check/")) return false;
  const item = challenges.get(url.pathname);
  const html = (body: string) => res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>浏览器交互验证</title>' + body);
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (!item || item.expires <= Date.now() || url.search) { res.statusCode = 404; html("<p>测试页面已失效。</p>"); return true; }
  if (req.method === "GET") {
    // Navigational form posts have a null Origin under a no-referrer policy.
    res.setHeader("referrer-policy", "same-origin");
    html('<h1>隔离浏览器测试</h1><form method="post"><label for="proof">验证文本</label> <input id="proof" name="proof" required><button>提交验证</button></form>');
    return true;
  }
  if (req.method !== "POST" || req.headers.origin !== url.origin || req.headers["sec-fetch-mode"] !== "navigate" ||
      !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    res.statusCode = 403; html("<p>请通过测试页面提交。</p>"); return true;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256) { res.statusCode = 413; html("<p>请求过大。</p>"); return true; }
  }
  if (new URLSearchParams(body).get("proof") !== item.input) {
    res.statusCode = 400; html("<p>验证文本不匹配。</p>"); return true;
  }
  item.submitted = true;
  html("<h1>验证成功</h1><p>" + item.result + "</p>");
  return true;
}

export async function verifiedBrowserInteraction(run: Run) {
  const evidence = run.events.flatMap((event) => {
    const match = event.summary?.match(/^方案浏览器交互验证 ([0-9a-f-]{36}) (\/router-browser-check\/[0-9a-f]{32})$/);
    return match && event.subject === "task-" + match[1] ? [match[2]!] : [];
  })[0];
  const item = evidence ? challenges.get(evidence) : undefined;
  if (!item?.submitted || item.expires <= Date.now()) return false;
  const folder = join(dataHome(), "worker", "runs", run.id + "-" + (run.attempts + 1));
  const names = await readdir(folder).catch(() => []);
  for (const name of names.filter((file) => /^stdout-[1-9]\d*\.log$/.test(file))) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > 16 * 1024 * 1024) continue;
    const log = await readFile(path, "utf8").catch(() => "");
    let started = false;
    let step = 0;
    for (const line of log.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event?.type === "thread.started" && event.thread_id === run.session) started = true;
        const call = event?.item;
        if (!started || event?.type !== "item.completed" || call?.type !== "mcp_tool_call" ||
            call.status !== "completed" || call.server !== "playwright" || !call.result || call.error) continue;
        const args = JSON.stringify(call.arguments ?? {});
        if (step === 0 && call.tool === "browser_navigate" && call.arguments?.url === item.url) step++;
        else if (step === 1 && ["browser_type", "browser_fill_form"].includes(call.tool) && args.includes(item.input)) step++;
        else if (step === 2 && call.tool === "browser_click") step++;
        else if (step === 3 && call.tool === "browser_snapshot" && JSON.stringify(call.result).includes(item.result)) return true;
      } catch {}
    }
  }
  return false;
}

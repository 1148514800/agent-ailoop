import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFeishuChat } from "./feishu-chat.ts";
import { dataHome } from "./router-rule-config.ts";
import { loadHub } from "./hub.ts";
import { createConsole } from "./proxy.ts";
import { createRouter } from "./router-dispatch.ts";
import { localRouterConfig, localRouterKey } from "./router.ts";

const root = join(import.meta.dirname, "..");
const dev = process.argv.includes("--dev");
if (dev) {
  const { build } = await import("vite");
  const watcher = await build({ root, build: { watch: {} } });
  if ("on" in watcher) await new Promise<void>((resolve, reject) => {
    watcher.on("event", (event) => {
      if (event.code === "END") resolve();
      if (event.code === "ERROR") reject(event.error);
    });
  });
}
const files = join(root, "dist");
if (!(await stat(join(files, "index.html")).catch(() => null))) {
  console.error("请先运行 npm run build，或用 npm run dev 启动开发服务器。");
  process.exit(1);
}

const media: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml",
};
async function serve(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url!, "http://127.0.0.1").pathname;
  const name = path === "/" ? "index.html" : path.slice(1);
  if (name !== "index.html" && name !== "mark.svg" && !/^assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  const file = join(files, name);
  if (!(await stat(file).catch(() => null))?.isFile()) { res.writeHead(404).end(); return; }
  res.setHeader("content-type", media[name.split(".").at(-1)!]);
  if (req.method === "HEAD") res.end();
  else createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

const portText = process.env.AUTOLOOP_CONSOLE_PORT ?? "4175";
const port = Number(portText);
if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port > 65535) {
  console.error("AUTOLOOP_CONSOLE_PORT 必须在 0 到 65535 之间。");
  process.exit(1);
}
const router = createRouter({ config: () => localRouterConfig(root), modelKey: () => localRouterKey(root), loadHub });
const feishu = createFeishuChat({ home: dataHome(), router, loadHub, modelKey: () => localRouterKey(root) });
const server = createConsole({ loadHub, router, frontend: serve, feishuStatus: feishu.status });
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? "端口已占用，请指定其他 AUTOLOOP_CONSOLE_PORT。" : "无法启动本地控制台。");
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  feishu.start();
  console.log("本地控制台 http://127.0.0.1:" + (server.address() as AddressInfo).port);
});

function close() {
  server.close();
  server.closeAllConnections();
  void feishu.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);

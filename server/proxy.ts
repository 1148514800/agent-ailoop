import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { redact, safeFact } from "./hub.ts";
import type { Hub } from "./hub.ts";
import { RouterError } from "./router.ts";
import type { RouterHandler } from "./router-dispatch.ts";

const COOKIE = "autoloop_console";
const SESSION_AGE = 12 * 60 * 60;
const token = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const number = (value: string, zero = false) => /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) && (zero || value !== "0");
type Session = { csrf: string; until: number; stop: AbortController };
type Row = Record<string, unknown>;

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function json(res: ServerResponse, status: number, value: unknown, hub?: Hub) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(hub ? redact(value, hub) : JSON.stringify(value));
}

async function readObject(req: IncomingMessage): Promise<Row> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "请求必须使用 JSON。");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16_384) throw new RequestError(413, "请求内容过长。");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* Invalid JSON also gets the object error. */ }
  throw new RequestError(400, "请求必须是一个 JSON 对象。");
}

type Route = { path: string; stream?: boolean; why?: boolean; fields?: string[]; answer?: boolean };

function route(method: string | undefined, url: URL, req: IncomingMessage): Route | null {
  const { pathname, searchParams } = url;
  if (method === "GET") {
    if (pathname === "/api/health") {
      if (!url.search) return { path: "/healthz" };
    } else if (pathname === "/api/state") {
      const before = searchParams.get("before");
      if (!url.search || (searchParams.size === 1 && before !== null && number(before))) {
        return { path: "/v1/state" + (before === null ? "" : "?before=" + before) };
      }
    } else if (pathname === "/api/stream") {
      const after = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : searchParams.get("after") ?? "0";
      if ((!url.search || (searchParams.size === 1 && searchParams.has("after"))) && number(after, true)) {
        return { path: "/v1/stream?after=" + after, stream: true };
      }
    } else if (/^\/api\/runs\/[1-9]\d*\/why$/.test(pathname) && !url.search) {
      return { path: pathname.replace("/api/", "/v1/"), why: true };
    } else return null;
    throw new RequestError(400, "查询参数不正确。");
  }
  if (method !== "POST" || url.search) return null;
  if (/^\/api\/runs\/[1-9]\d*\/cancel$/.test(pathname)) return { path: pathname.replace("/api/", "/v1/"), fields: [] };
  const card = /^\/api\/cards\/[1-9]\d*\/(answer|resolve)$/.exec(pathname);
  if (card) return { path: pathname.replace("/api/", "/v1/"), fields: card[1] === "answer" ? ["choice", "text"] : ["reason"], answer: card[1] === "answer" };
  const rule = /^\/api\/rules\/([^/]+)\/(pause|resume|run|replay)$/.exec(pathname);
  if (rule) {
    let name: string;
    try { name = decodeURIComponent(rule[1]); } catch { throw new RequestError(400, "规则名不正确。"); }
    if (!name || name === "." || name === "..") throw new RequestError(400, "规则名不正确。");
    const fields = { pause: ["reason", "until"], resume: [], run: ["subject", "reason"], replay: ["since"] }[rule[2]]!;
    return { path: "/v1/rules/" + encodeURIComponent(name) + "/" + rule[2], fields };
  }
  return null;
}

function stateForBrowser(value: Row) {
  const { agents, rulesRevision: _rulesRevision, ...rest } = value;
  return {
    ...rest, agents: Array.isArray(agents) ? (agents as Row[]).map(({ id, name, use, worker, seenAt, online, totals }) =>
      ({ id, name, use, worker, seenAt, online, totals })) : agents,
  };
}

async function pipeFacts(upstream: Response, res: ServerResponse, signal: AbortSignal, hub: Hub) {
  if (!upstream.body) throw new Error("Missing stream");
  res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
  res.flushHeaders();
  const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const line = buffer.slice(0, end).split("\n").find((item) => item.startsWith("data: "));
        buffer = buffer.slice(end + 2);
        if (line) {
          const fact = safeFact(JSON.parse(line.slice(6)));
          if (!res.write("id: " + fact.seq + "\nevent: fact\ndata: " + redact(fact, hub) + "\n\n")) {
            await once(res, "drain", { signal });
          }
        }
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    res.end();
  }
}

export function createConsole(options: {
  loadHub(): Promise<Hub>; router?: RouterHandler;
  frontend?(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}) {
  const sessions = new Map<string, Session>();
  const cookie = (id: string) => COOKIE + "=" + id + "; Path=/; Max-Age=" + SESSION_AGE + "; HttpOnly; SameSite=Strict";
  const remove = (id: string) => { sessions.get(id)?.stop.abort(); sessions.delete(id); };
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'; img-src 'self' data:");
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    try {
      if (req.headers.host !== new URL(origin).host || !req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
        throw new RequestError(403, "请用终端显示的本机地址打开控制台。");
      }
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith("/api/")) {
        if ((req.method === "GET" || req.method === "HEAD") && options.frontend) return await options.frontend(req, res);
        throw new RequestError(404, "没有这个地址。");
      }
      if ((req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") ||
          (req.method === "POST" && req.headers.origin !== origin)) {
        throw new RequestError(403, "请求来源与控制台地址不一致。");
      }
      const id = req.headers.cookie?.split(/;\s*/).find((part) => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
      const now = Date.now();
      const session = sessions.get(id);
      if (session && session.until <= now) remove(id);
      if (url.pathname === "/api/session" && !url.search) {
        if (req.method === "HEAD") return void res.writeHead(204).end();
        if (req.method === "GET") {
          if (session && sessions.has(id)) return json(res, 200, { csrf: session.csrf });
          for (const [old, entry] of sessions) if (entry.until <= now) remove(old);
          if (sessions.size >= 32) remove(sessions.keys().next().value!);
          const fresh = token();
          const csrf = token();
          sessions.set(fresh, { csrf, until: now + SESSION_AGE * 1000, stop: new AbortController() });
          res.setHeader("set-cookie", cookie(fresh));
          return json(res, 200, { csrf });
        }
      }
      if (!session || !sessions.has(id)) throw new RequestError(401, "本机会话已失效，请刷新页面。");
      if (req.method === "POST") {
        const csrf = req.headers["x-console-csrf"];
        if (typeof csrf !== "string" || !equal(csrf, session.csrf)) throw new RequestError(403, "页面验证已失效，请刷新后重试。");
      }
      if (req.method === "POST" && url.pathname === "/api/router/message" && !url.search) {
        if (!options.router) throw new RouterError(503, "控制台未加载 AI Router。");
        const body = await readObject(req);
        const gone = new AbortController();
        res.once("close", () => gone.abort());
        const signal = AbortSignal.any([gone.signal, session.stop.signal,
          AbortSignal.timeout(Math.max(1, session.until - Date.now()))]);
        const result = await options.router(body, signal);
        if (!res.destroyed) json(res, 200, result);
        return;
      }
      const target = route(req.method, url, req);
      if (!target) throw new RequestError(404, "控制台没有开放这个接口。");
      const body = target.fields ? await readObject(req) : undefined;
      if (body && (Object.keys(body).some((key) => !target.fields!.includes(key)) ||
          (target.answer && Object.keys(body).length !== 1))) throw new RequestError(400, "提交字段不正确。");

      let hub: Hub;
      try { hub = await options.loadHub(); }
      catch { throw new RequestError(503, "无法读取本机中台配置。请检查 config.json 的本人密钥和回环地址。"); }
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      const sessionTime = AbortSignal.timeout(Math.max(1, session.until - Date.now()));
      const active = AbortSignal.any([gone.signal, session.stop.signal, sessionTime]);
      const deadline = setTimeout(() => gone.abort(), 12_000);
      try {
        const upstream = await fetch(hub.url + target.path, {
          method: req.method, redirect: "error", signal: active,
          headers: { ...(target.path !== "/healthz" && { authorization: "Bearer " + hub.owner }), ...(body && { "content-type": "application/json" }) },
          ...(body && { body: JSON.stringify(body) }),
        });
        if (target.stream && upstream.ok && upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
          clearTimeout(deadline);
          return await pipeFacts(upstream, res, active, hub);
        }
        const value = await upstream.json();
        if (!upstream.ok) {
          if (upstream.status === 401) throw new RequestError(502, "中台拒绝了本机配置中的本人密钥。");
          if (upstream.status >= 500) throw new RequestError(502, "中台暂时无法完成请求。");
          return json(res, upstream.status, { error: typeof value?.error === "string" ? value.error : "中台拒绝了请求。" }, hub);
        }
        if (target.stream) throw new Error("Invalid stream response");
        return json(res, upstream.status, target.why ? (value as Row[]).map(safeFact) : target.path.startsWith("/v1/state") ? stateForBrowser(value) : value, hub);
      } catch (error) {
        if (error instanceof RequestError) throw error;
        if (res.headersSent) { res.end(); return; }
        throw new RequestError(502, req.method === "POST"
          ? "提交结果暂未确认。请先刷新状态，核对是否已经生效。"
          : "无法读取中台响应。请确认中台已经启动。");
      } finally { clearTimeout(deadline); }
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      if (!req.complete) res.setHeader("connection", "close");
      const safe = error instanceof RequestError || error instanceof RouterError;
      json(res, safe ? error.status : 500, { error: safe ? error.message : "控制台暂时无法处理请求。" });
    }
  });
  return server;
}

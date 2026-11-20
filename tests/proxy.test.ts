// A browser without the local session, a foreign origin, or an unsupported route must never reach the hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectFolderPicker } from "../server/project-folder-picker.ts";
import { createConsole } from "../server/proxy.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

test("a browser opens a local session without credentials and writes with CSRF, including zero-based answers and cursor forwarding", async (t) => {
  const calls: { url: string; method: string; body: unknown; key: string | undefined }[] = [];
  const hub = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    calls.push({ url: req.url!, method: req.method!, key: req.headers.authorization, body: body.length ? JSON.parse(Buffer.concat(body).toString()) : null });
    if (req.url?.startsWith("/v1/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end('id: 43\nevent: fact\ndata: {"seq":43,"at":0,"type":"finish","changes":[]}\n\n');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, detail: "owner-testing-key" }));
  });
  const hubUrl = await listen(hub);
  t.after(() => hub.close());
  const proxy = createConsole({ loadHub: async () => ({ url: hubUrl, owner: "owner-testing-key", secrets: [] }) });
  const base = await listen(proxy);
  t.after(() => { proxy.close(); proxy.closeAllConnections(); });

  const write = (body: object, headers: Record<string, string> = {}) => ({
    method: "POST", headers: { origin: base, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(base + "/api/state")).status, 401);
  const foreign = await fetch(base + "/api/session", { headers: { origin: "https://elsewhere.invalid" } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("set-cookie"), null);
  assert.equal((await fetch(base + "/api/session", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    get(base + "/api/session", { headers: { host: "elsewhere.invalid" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHost, 403);
  const probe = await fetch(base + "/api/session", { method: "HEAD" });
  assert.equal(probe.status, 204);
  assert.equal(probe.headers.get("set-cookie"), null);
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  assert.match(session.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const { csrf } = await session.json();
  assert.equal(typeof csrf, "string");
  const headers = { cookie, "x-console-csrf": csrf };
  const openedAgain = await fetch(base + "/api/session", { headers: { cookie } });
  assert.deepEqual(await openedAgain.json(), { csrf });
  assert.equal(openedAgain.headers.get("set-cookie"), null);
  const withCookie = { headers: { cookie } };
  assert.equal((await fetch(base + "/api/cards/56/answer", write({ choice: 0 }, { cookie }))).status, 403);
  assert.equal((await fetch(base + "/api/cards/56/answer", write({ choice: 0, by: "someone" }, headers))).status, 400);
  assert.equal((await fetch(base + "/api/v1/keys/owner/owner", write({}, headers))).status, 404);
  assert.equal((await fetch(base + "/api/state?target=anything", withCookie)).status, 400);
  assert.equal(calls.length, 0);

  const state = await fetch(base + "/api/state?before=9", withCookie);
  assert.equal(state.status, 200);
  assert.doesNotMatch(await state.text(), /owner-testing-key/);
  assert.equal((await fetch(base + "/api/cards/56/answer", write({ choice: 0 }, headers))).status, 200);
  const stream = await fetch(base + "/api/stream?after=40", { headers: { cookie, "last-event-id": "42" } });
  assert.match(await stream.text(), /id: 43/);
  assert.deepEqual(calls.map(({ url, body, key }) => [url, body, key]), [
    ["/v1/state?before=9", null, "Bearer owner-testing-key"],
    ["/v1/cards/56/answer", { choice: 0 }, "Bearer owner-testing-key"],
    ["/v1/stream?after=42", null, "Bearer owner-testing-key"],
  ]);

  assert.equal((await fetch(base + "/api/login", write({}, headers))).status, 404);
  assert.equal((await fetch(base + "/api/logout", write({}, headers))).status, 404);
});

test("folder browsing requires local authorization, validates the selection and opens one window at a time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "router-folder-picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "中文 工程 ' & $");
  await mkdir(folder);
  const opened = Promise.withResolvers<void>();
  const select = Promise.withResolvers<string>();
  let calls = 0;
  const pickFolder = createProjectFolderPicker(async () => {
    calls++;
    if (calls === 1) {
      opened.resolve();
      return select.promise;
    }
    return calls === 2 ? null : join(root, "missing");
  });
  const server = createConsole({ pickFolder, loadHub: async () => { throw new Error("Unexpected Hub request"); } });
  const base = await listen(server);
  t.after(() => { select.resolve(folder); server.close(); server.closeAllConnections(); });
  const session = await fetch(base + "/api/session");
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const csrf = (await session.json()).csrf;
  const url = base + "/api/router/projects/pick-folder";
  const browse = (headers: Record<string, string> = {}, body: object = {}) => fetch(url, {
    method: "POST",
    headers: { cookie, origin: base, "x-console-csrf": csrf, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await fetch(url, { headers: { cookie } })).status, 404);
  assert.equal((await browse({ cookie: "" })).status, 401);
  assert.equal((await browse({ "x-console-csrf": "" })).status, 403);
  assert.equal((await browse({ origin: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await browse({}, { command: "invalid" })).status, 400);
  assert.equal(calls, 0);

  const first = browse();
  await opened.promise;
  assert.equal((await browse()).status, 409);
  assert.equal(calls, 1);
  select.resolve(folder);
  assert.deepEqual(await (await first).json(), { directory: await realpath(folder) });
  assert.deepEqual(await (await browse()).json(), { directory: null });
  const invalid = await browse();
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /目录不存在/);
});

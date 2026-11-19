// Model errors must never turn into executions, and a provider sees only the routing prompt and the user's text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterError, classify, localRouterConfig, routerConfig } from "../server/router.ts";

const settings = {
  AUTOLOOP_ROUTER_ENABLED: "true", AUTOLOOP_ROUTER_BASE_URL: "http://127.0.0.1:9999/v1",
  AUTOLOOP_ROUTER_API_KEY: "test-model-key", AUTOLOOP_ROUTER_MODEL: "mock-model",
};
const config = routerConfig(settings);
const payload = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

test("a standard Chat Completions reply is validated and sent without tools", async () => {
  const result = await classify(config, "你好", AbortSignal.timeout(1000), async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:9999/v1/chat/completions");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.model, "mock-model");
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, 2);
    assert.deepEqual(request.messages[1], { role: "user", content: "你好" });
    return payload('{"action":"reply","needs_plan":false,"answer":"你好，有什么可以帮你？"}');
  });
  assert.equal(result.action, "reply");
});

test("strict decisions reject invalid JSON, extra permissions, incompatible fields and oversized answers", async () => {
  for (const value of [
    "not JSON", '{"action":"execute","needs_plan":true,"answer":"","cwd":"/"}',
    '{"action":"reply","needs_plan":true,"answer":"你好"}',
    '{"action":"execute","needs_plan":false,"answer":"run this"}',
    JSON.stringify({ action: "reply", needs_plan: false, answer: "长".repeat(1001) }),
  ]) await assert.rejects(classify(config, "task", new AbortController().signal, async () => payload(value)),
    (err) => err instanceof RouterError && err.status === 502);
});

test("missing credentials, timeouts and upstream errors yield safe, explicit errors", async () => {
  assert.throws(() => routerConfig({ ...settings, AUTOLOOP_ROUTER_API_KEY: "" }), /AUTOLOOP_ROUTER_API_KEY/);
  await assert.rejects(classify(config, "task", new AbortController().signal, async (_url, opts) => {
    return await new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("missing abort")), 100);
      opts!.signal!.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(opts!.signal!.reason);
      }, { once: true });
    });
  }, 5), (err) => err instanceof RouterError && err.status === 504 && /超时/.test(err.message));
  await assert.rejects(classify(config, "task", new AbortController().signal, async () =>
    new Response(config.key, { status: 401 })), (err) => err instanceof RouterError && !err.message.includes(config.key));
});

test("Finder launches can load .env.local from the project root without shell exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autoloop-router-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env.local"), Object.entries(settings).map(([key, value]) => key + "=" + value).join("\n"));
  assert.equal((await localRouterConfig(root, {})).key, settings.AUTOLOOP_ROUTER_API_KEY);
  assert.equal((await localRouterConfig(root, { AUTOLOOP_ROUTER_MODEL: "override" })).model, "override");
});

// The vendored tree has no Git directory of its own, so give the upstream CLI its actual snapshot ID.
process.env.AGENT_AUTOLOOP_COMMIT = "ca5c0ffe2c92be17502c4f1a75cdb71823eeafef";
await import(new URL("../agent-autoloop/bin/agent-autoloop.ts", import.meta.url).href);

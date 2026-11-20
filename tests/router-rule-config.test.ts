// Failed staging and external writes must leave a complete rules file and clean up the temporary file.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSnapshot, replaceConfig } from "../server/router-rule-config.ts";

test("a failed or stale staged rules replacement preserves the current file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-rule-replace-"));
  const file = join(directory, "rules.json");
  try {
    await writeFile(file, "original");
    const before = await configSnapshot(file);
    await assert.rejects(replaceConfig(file, before, "staged", async () => { throw new Error("interrupted"); }), { status: 503 });
    assert.equal(await readFile(file, "utf8"), "original");
    await assert.rejects(replaceConfig(file, before, "staged", () => writeFile(file, "external edit")), { status: 409 });
    assert.equal(await readFile(file, "utf8"), "external edit");
    assert.deepEqual(await readdir(directory), ["rules.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

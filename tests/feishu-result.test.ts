// A completed task must return its own final answer, not a progress message or another session's output.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexResult } from '../server/feishu-result.ts';

test('only returns a completed matching Codex session and removes the internal receipt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'feishu-result-'));
  try {
    const dir = join(home, 'worker', 'runs', '7-1');
    await mkdir(dir, { recursive: true });
    const events = [{type:'thread.started',thread_id:'session-1'}, {type:'item.completed',item:{type:'agent_message',text:'完成\n\n# 结果\n\n```agent-autoloop\n{"notice":[]}\n```'}}, {type:'turn.completed'}];
    await writeFile(join(dir, 'stdout-1.log'), events.map(x => JSON.stringify(x)).join('\n'));
    assert.equal(await codexResult(home, 7, 0, 'session-1'), '完成\n\n# 结果');
    assert.equal(await codexResult(home, 7, 0, 'other'), undefined);
    await writeFile(join(dir, 'stdout-1.log'), events.slice(0, 2).map(x => JSON.stringify(x)).join('\n'));
    assert.equal(await codexResult(home, 7, 0, 'session-1'), undefined);
  } finally { await rm(home, {recursive:true, force:true}); }
});

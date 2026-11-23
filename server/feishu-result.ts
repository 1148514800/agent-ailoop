import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function codexResult(home: string, run: number, attempts: number, session: string) {
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempts) || attempts < 0 || !session) return;
  const dir = join(home, 'worker', 'runs', `${run}-${attempts + 1}`);
  const names = (await readdir(dir).catch(() => []))
    .filter(name => /^stdout-[1-9]\d*\.log$/.test(name))
    .sort((a, b) => Number(b.slice(7, -4)) - Number(a.slice(7, -4)));
  for (const name of names) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > 16 * 1024 * 1024) continue;
    let thread: unknown, text: unknown, completed = false;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event?.type === 'thread.started') thread = event.thread_id;
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
        if (event?.type === 'turn.completed') completed = true;
        if (event?.type === 'turn.failed') completed = false;
      } catch { /* Ignore non-JSON output. */ }
    }
    if (thread !== session || !completed || typeof text !== 'string') continue;
    return text.replace(/(?<=^|\n)[ \t]*```agent-autoloop[ \t]*\r?\n(?:[^\n]*\n)*?[ \t]*```[ \t]*(?=\r?\n|$)/g, '').trim();
  }
}

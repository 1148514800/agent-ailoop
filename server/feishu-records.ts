import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FeishuMessage } from "./feishu-cli.ts";

export function feishuId(value: string) {
  const hash = createHash("sha256").update("autoloop-feishu:" + value).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), "4" + hash.slice(13, 16), "8" + hash.slice(17, 20), hash.slice(20, 32)].join("-");
}

export type FeishuTask = {
  id: string; user: string; chat: string; project: string | null; target: string | null;
  event: number | null; run: number | null; approval: number | null; created: number; active: number;
};
type Delivery = { id: string; stage: string; text: string; tries: number; user: string; project: string | null };

export async function openFeishuRecords(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, "feishu-chat.sqlite");
  await open(file, "ax", 0o600).then((handle) => handle.close(), (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(file);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("invalid conversation database");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS chats (user TEXT, chat TEXT, project TEXT, PRIMARY KEY(user, chat));
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, chat TEXT NOT NULL, project TEXT, target TEXT,
      event INTEGER, run INTEGER, approval INTEGER, created INTEGER NOT NULL, active INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_active ON tasks(active, created);
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT, stage TEXT, text TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id, stage)
    );
  `);
  function transaction<T>(work: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const task = (id: string) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as FeishuTask | undefined;
  const enqueue = (id: string, stage: string, text: string) => {
    db.prepare("INSERT OR IGNORE INTO outbox(id,stage,text) VALUES(?,?,?)").run(id, stage, text);
  };
  return {
    close: () => db.close(),
    task,
    current(user: string, chat: string) {
      return db.prepare("SELECT project FROM chats WHERE user=? AND chat=?").get(user, chat)?.project as string | undefined;
    },
    accept(message: FeishuMessage, project: string | undefined, target: string | undefined, limit: number, command: boolean) {
      return transaction(() => {
        if (task(message.id)) return false;
        const count = db.prepare("SELECT count(*) AS count FROM tasks WHERE active=1").get()!.count as number;
        const full = !command && count >= limit;
        db.prepare("INSERT INTO tasks(id,user,chat,project,target,created,active) VALUES(?,?,?,?,?,?,?)")
          .run(message.id, message.user, message.chat, project ?? null, target ?? null, Date.now(), full || command ? 0 : 1);
        if (full) enqueue(message.id, "initial", "飞书任务已达并发上限，请等现有任务结束后发送一条新消息。");
        return !full;
      });
    },
    reply(id: string, text: string, selection?: string) {
      transaction(() => {
        if (selection) {
          const row = task(id)!;
          db.prepare("INSERT OR REPLACE INTO chats(user,chat,project) VALUES(?,?,?)").run(row.user, row.chat, selection);
        }
        db.prepare("UPDATE tasks SET active=0 WHERE id=?").run(id);
        enqueue(id, "initial", text);
      });
    },
    accepted(id: string, event: number, run: number | null, text: string) {
      transaction(() => {
        db.prepare("UPDATE tasks SET event=?,run=? WHERE id=?").run(event, run, id);
        enqueue(id, "initial", text);
      });
    },
    status(id: string, stage: string, text: string, run: number, approval: number | null, finished: boolean) {
      transaction(() => {
        db.prepare("UPDATE tasks SET run=?,approval=?,active=? WHERE id=?").run(run, approval, finished ? 0 : 1, id);
        if (text) enqueue(id, stage, text);
      });
    },
    abandon(id: string) {
      transaction(() => {
        db.prepare("UPDATE tasks SET active=0 WHERE id=?").run(id);
        db.prepare("UPDATE outbox SET tries=5,text='' WHERE id=?").run(id);
      });
    },
    active: () => db.prepare("SELECT * FROM tasks WHERE active=1 ORDER BY created").all() as FeishuTask[],
    pending(at: number) {
      // A final reply stays behind its creation receipt even when the receipt has to retry.
      return db.prepare(`SELECT o.*, t.user, t.project FROM outbox o JOIN tasks t ON t.id=o.id
        WHERE o.tries<5 AND o.due<=? AND NOT EXISTS (
          SELECT 1 FROM outbox earlier WHERE earlier.id=o.id AND earlier.rowid<o.rowid AND earlier.tries<5
        ) ORDER BY o.rowid LIMIT 20`).all(at) as Delivery[];
    },
    sent(id: string, stage: string) {
      // Keep the unique receipt, but discard the message body once it has been delivered.
      db.prepare("UPDATE outbox SET tries=5,text='' WHERE id=? AND stage=?").run(id, stage);
    },
    retry(id: string, stage: string, tries: number) {
      db.prepare("UPDATE outbox SET tries=?,due=? WHERE id=? AND stage=?").run(tries, Date.now() + 2 ** tries * 2000, id, stage);
    },
  };
}

import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { commandLine } from "../agent-autoloop/host/command.ts";
import { openId } from "./feishu-config.ts";

const eventKey = "im.message.receive_v1";
export type FeishuMessage = { id: string; chat: string; user: string; text: string };

export function parseFeishuMessage(line: string): FeishuMessage | undefined {
  if (line.length > 65536) return;
  try {
    const event = JSON.parse(line);
    if (event.type !== eventKey || event.chat_type !== "p2p" || event.sender_type !== "user" || event.message_type !== "text" ||
        event.root_id || event.thread_id || event.reply_to || event.forwarded || event.is_forwarded || event.parent_id ||
        !openId(event.sender_id) || typeof event.message_id !== "string" || !/^om_[a-zA-Z0-9_-]{1,125}$/.test(event.message_id) ||
        typeof event.chat_id !== "string" || !/^oc_[a-zA-Z0-9_-]{1,125}$/.test(event.chat_id) ||
        typeof event.content !== "string" || !event.content.isWellFormed() || !event.content.trim()) return;
    return { id: event.message_id, chat: event.chat_id, user: event.sender_id, text: event.content.trim() };
  } catch { return; }
}

async function* lines(input: Readable) {
  input.setEncoding("utf8");
  let rest = "";
  let overflow = false;
  for await (const chunk of input) {
    const pieces = String(chunk).split("\n");
    for (const [index, piece] of pieces.entries()) {
      if (!overflow && rest.length + piece.length <= 65536) rest += piece;
      else overflow = true;
      if (index === pieces.length - 1) break;
      if (!overflow) yield rest.replace(/\r$/, "");
      rest = "";
      overflow = false;
    }
  }
  if (rest && !overflow) yield rest;
}

export class FeishuCliError extends Error {
  readonly kind: "missing" | "authorization" | "connection" | "send";
  constructor(kind: FeishuCliError["kind"]) {
    super(kind);
    this.kind = kind;
  }
}

export async function consumeFeishu(program: string, signal: AbortSignal, ready: () => void, receive: (message: FeishuMessage) => Promise<void>) {
  const [file, args] = commandLine([program, "event", "consume", eventKey, "--as", "bot"]);
  if (signal.aborted) return;
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let missing = false, listening = false, auth = false;
  child.on("error", (error: NodeJS.ErrnoException) => { missing = error.code === "ENOENT"; });
  child.stdin.on("error", () => {});
  const stop = () => { child.stdin.end(); child.kill(); };
  signal.addEventListener("abort", stop, { once: true });
  const startup = setTimeout(stop, 30_000);
  const ended = new Promise<number | null>((resolve) => child.on("close", resolve));
  const stderr = (async () => {
    for await (const line of lines(child.stderr)) {
      if (line === "[event] ready event_key=" + eventKey) {
        listening = true;
        clearTimeout(startup);
        ready();
      } else if (line.startsWith("{") && line.length < 8192) {
        try {
          const { error } = JSON.parse(line);
          auth ||= ["auth", "missing_scope", "missing_token"].some((part) => error?.type === part || error?.subtype === part);
        } catch {}
      }
    }
  })().catch(() => {});
  try {
    for await (const line of lines(child.stdout)) {
      // A genuine event also proves delivery if the two pipes reach Node out of order.
      const message = parseFeishuMessage(line);
      if (message && !signal.aborted) await receive(message);
    }
    const status = await ended;
    await stderr;
    if (!signal.aborted) throw new FeishuCliError(missing ? "missing" : auth || status === 3 ? "authorization" : "connection");
  } finally {
    if (!listening) clearTimeout(startup);
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null && child.signalCode === null) stop();
    await ended;
  }
}

export async function replyFeishu(program: string, id: string, text: string, uuid: string, signal: AbortSignal) {
  const [file, args] = commandLine([program, "im", "+messages-reply", "--message-id", id, "--as", "bot", "--idempotency-key", uuid, "--text", "-"]);
  return new Promise<void>((resolve, reject) => {
    const child = execFile(file, args, { timeout: 20_000, maxBuffer: 128 * 1024, signal, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      try {
        if (error) throw error;
        const result = JSON.parse(String(stdout));
        if (result.ok === false || result.error || (result.code !== undefined && result.code !== 0) ||
            !/^om_[\w-]+$/.test(result.data?.message_id ?? "")) throw new Error();
        resolve();
      } catch { reject(new FeishuCliError("send")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

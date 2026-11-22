import { setTimeout as wait } from "node:timers/promises";
import type { FeishuChatStatus } from "../shared/types.ts";
import type { RouterRun } from "../shared/router.ts";
import type { Hub } from "./hub.ts";
import type { createRouter } from "./router-dispatch.ts";
import { RouterError } from "./router.ts";
import { digest } from "./router-rule-config.ts";
import { FeishuCliError, consumeFeishu, replyFeishu, type FeishuMessage } from "./feishu-cli.ts";
import { readFeishuConfig } from "./feishu-config.ts";
import { feishuId, openFeishuRecords, type FeishuTask } from "./feishu-records.ts";

const help = "/projects 查看授权项目\n/use <projectId> 选择项目\n/current 查看当前项目\n普通文字交给 AI Router。审批请使用飞书审批卡片。";
const connectionErrors = {
  missing: "未找到 lark-cli，请安装或设置 CLI 路径。",
  authorization: "飞书机器人尚未授权收消息，请检查 CLI 配置和应用权限。",
  connection: "飞书消息连接中断，正在重连。",
  send: "飞书回复发送失败，将按限额重试。",
};

function publicSummary(input: string | null | undefined, secrets: (string | undefined)[], limit: number) {
  if (!input) return "";
  let text = input;
  for (const secret of secrets.filter((value): value is string => !!value).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, "[已隐藏]");
  }
  text = text.replace(/```[\s\S]*?(?:```|$)|-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, "[已隐藏]")
    .replace(/(?:\bBearer\s+\S+|\b[a-z0-9_-]*(?:key|secret|token|password|credential)[a-z0-9_-]*\s*[:=]\s*[^\r\n]+|(?:密钥|令牌|口令|密码|凭据)\s*[：:]\s*[^\r\n]+)/gi, "[已隐藏]")
    .replace(/\b[A-Z_][A-Z0-9_]{2,}\s*=\s*[^\r\n]+/g, "[已隐藏]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA|eyJ)[\w.-]+/g, "[已隐藏]")
    .replace(/\b[A-Za-z0-9_+/-]{32,}={0,2}\b/g, "[已隐藏]")
    .replace(/(?:https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9_.-])(?:~\/|\/|\\\\))[^\s<>`"'，。；、！？）)]+/g, "[地址已隐藏]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return [...text].length > limit ? [...text].slice(0, limit).join("") + "…" : text;
}

type Outcome = { event: number; runs: (Omit<RouterRun, "id"> & { run: number })[]; paused: string[]; routed: string[] };
type Fact = { changes: { table: string; key: string; row: Record<string, unknown> | null }[] };
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const targetOf = (hub: Hub | null) => hub?.source ? digest(JSON.stringify([hub.url, hub.source.name, hub.source.key])) : undefined;

async function hubGet<T>(hub: Hub, path: string, key: string, signal: AbortSignal) {
  const response = await fetch(hub.url + path, {
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { authorization: "Bearer " + key },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("hub unavailable");
  return await response.json() as T;
}

const approvalOf = (facts: Fact[], run: number) => {
  const cards = new Map<number, Record<string, unknown>>();
  for (const { changes } of facts) for (const { table, row, key } of changes) {
    if (table !== "cards") continue;
    if (row?.run_id === run && row.kind === "ask") cards.set(Number(key), row);
    else if (!row) cards.delete(Number(key));
  }
  return [...cards.entries()].find(([, card]) => card.state === "open") ??
    [...cards.entries()].find(([, card]) => positive(card.answer_event)) ??
    [...cards.entries()].find(([, card]) => card.state === "closed");
};

function continuation(facts: Fact[], event: number, run: number) {
  return facts.flatMap(({ changes }) => changes)
    .findLast(({ table, row }) => table === "run_events" && row?.event_id === event && positive(row.run_id) && row.run_id !== run)?.row?.run_id as number | undefined;
}

function continuationRun(facts: Fact[], run: number): RouterRun | undefined {
  const changes = facts.flatMap((fact) => fact.changes);
  const row = changes.findLast(({ table, key }) => table === "runs" && key === String(run))?.row;
  if (!row || typeof row.state !== "string") return;
  const eventCount = new Set(changes.filter(({ table, row }) => table === "run_events" && row?.run_id === run).map(({ key }) => key)).size;
  return { id: run, state: row.state as RouterRun["state"], attempts: Number(row.attempts),
    summary: eventCount === 1 && typeof row.summary === "string" ? row.summary : null, error: null };
}

export function createFeishuChat(options: {
  home: string; router: ReturnType<typeof createRouter>; loadHub(): Promise<Hub>;
  modelKey?(): Promise<string | undefined>; pollMs?: number; reconnectMs?: number;
}) {
  const stop = new AbortController();
  const state: FeishuChatStatus = { entry: "disabled", receive: "unverified", error: null };
  let running: Promise<void> | undefined;
  let closing = false;
  const config = () => readFeishuConfig(options.home);
  async function run() {
    const initial = await config();
    if (!initial.config || stop.signal.aborted) {
      if (initial.error) Object.assign(state, { entry: "setup", error: initial.error });
      return;
    }
    const program = initial.config.program ?? "lark-cli";
    const records = await openFeishuRecords(options.home);
    const inflight = new Set<string>();
    const signal = stop.signal;
    const secrets = async (hub: Hub | null) => [hub?.owner, hub?.source?.key, ...(hub?.secrets ?? []), await options.modelKey?.()];

    async function receive(message: FeishuMessage) {
      const current = (await config()).config;
      const user = current?.users.get(message.user);
      if (!user || !current || (current.program ?? "lark-cli") !== program || records.task(message.id)) return;
      state.receive = "verified";
      state.entry = "listening";
      const selected = records.current(message.user, message.chat) ?? user.defaultProject;
      const project = selected && user.projects.includes(selected) ? selected : undefined;
      const command = message.text.startsWith("/") || [...message.text].length > current.maxLength;
      const hub = await options.loadHub().catch(() => null);
      const target = targetOf(hub);
      if (signal.aborted || !records.accept(message, project, target, current.maxConcurrent, command)) return;
      function reply(text: string, selection?: string) { records.reply(message.id, text, selection); }
      if ([...message.text].length > current.maxLength) return reply("消息超过长度限制。");
      if (message.text === "/help") return reply(help);
      if (message.text === "/current") return reply(project ? "当前项目 " + project : "尚未选择授权项目。");
      if (message.text === "/projects" || message.text.startsWith("/use ")) {
        const requested = message.text.slice(5).trim();
        if (message.text !== "/projects" && !user.projects.includes(requested)) return reply("该项目未授权。请发送 /projects。");
        const projects = await options.router.projects(signal).catch(() => null);
        if (!projects) return reply("暂时无法读取中台项目。");
        const allowed = projects.projects.filter((item) => !item.error && user.projects.includes(item.id));
        if (message.text === "/projects") return reply(allowed.length ? "当前可用项目\n" + allowed.map((item) => item.id).join("\n") : "当前没有可用的授权项目。");
        if (!allowed.some((item) => item.id === requested)) return reply("该项目当前不可用。");
        return reply("已切换到 " + requested + " 项目。", requested);
      }
      if (command) return reply(help);

      inflight.add(message.id);
      try {
        const privateValues = await secrets(hub);
        const result = await options.router.remoteMessage(feishuId(message.id), message.text, project, signal, async () => {
          const latest = (await config()).config;
          if (!project || !latest?.users.get(message.user)?.projects.includes(project) || (latest.program ?? "lark-cli") !== program) {
            throw new RouterError(403, "当前未选择可执行的授权项目。请发送 /projects 和 /use <projectId>。");
          }
          if (!target || targetOf(await options.loadHub().catch(() => null)) !== target) {
            throw new RouterError(409, "本机中台连接已变更，请稍后发送一条新消息。");
          }
        });
        if (result.action === "reply") return reply(publicSummary(result.answer, privateValues, 1800) || "没有可显示的回复。");
        if (result.status === "unmatched") return reply("任务未创建，中台未匹配到规则。");
        const plan = publicSummary(result.planName ?? result.execution_profile, privateValues, 100);
        const agent = publicSummary(result.execution?.name, privateValues, 100);
        const model = publicSummary(result.execution?.model, privateValues, 100);
        const receipt = [result.run ? "任务已创建 · Run #" + result.run.id : "项目已暂停，事件已记录，等待补跑。",
          "项目 " + project, plan && "方案 " + plan, agent && "Agent " + agent, model && "模型 " + model,
          result.needs_plan && "将先规划", result.run && "状态 " + ({ queued: "排队中", claimed: "执行中", done: "已完成",
            nothing: "无需处理", cancelled: "已停止", unknown: "未知" }[result.run.state])].filter(Boolean).join("\n");
        records.accepted(message.id, result.eventId, result.run?.id ?? null, receipt);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RouterError && error.status < 500) {
          const explanation = error.status === 403 ? "当前未选择可执行的授权项目。请发送 /projects 和 /use <projectId>。"
            : publicSummary(error.message, await secrets(hub), 220);
          reply(explanation || "任务未创建，请检查项目和授权。");
        } else if (!target) reply("暂时无法处理，请检查本机 Router 和中台。");
        // If the dispatch acknowledgement was lost, the poller can recover the event without a second model call.
      } finally { inflight.delete(message.id); }
    }

    async function track(task: FeishuTask, hub: Hub, privateValues: (string | undefined)[]) {
      if (!hub.source || targetOf(hub) !== task.target || inflight.has(task.id)) return;
      let event = task.event;
      if (!event) {
        const found = await hubGet<{ event: number }>(hub, "/v1/events?key=router-" + feishuId(task.id), hub.source.key, signal);
        if (!positive(found?.event)) {
          if (Date.now() - task.created > 120_000) records.reply(task.id, "未确认任务创建。请在控制台核对后再发送新消息。");
          return;
        }
        event = found.event;
      }
      const outcome = await hubGet<Outcome>(hub, "/v1/events/" + event, hub.source.key, signal);
      if (!outcome || outcome.event !== event) return;
      let run = outcome.runs.at(-1);
      let current: RouterRun | undefined = run && { ...run, id: run.run };
      if (!task.event || (!task.run && current)) records.accepted(task.id, event, current?.id ?? null,
        current ? "任务已创建 · Run #" + current.id + "\n项目 " + task.project : "项目已暂停，事件已记录，等待补跑。");
      if (!current) return;
      let facts: Fact[] | undefined;
      if (task.run && task.run !== current.id && task.approval) {
        facts = await hubGet<Fact[]>(hub, "/v1/runs/" + task.run + "/why", hub.owner, signal);
        if (!facts) return;
        current = continuationRun(facts, task.run);
        if (!current) return;
      }
      const visited = new Set<number>();
      while (current.state === "done" || current.state === "nothing") {
        if (visited.has(current.id) || visited.size >= 8) return;
        visited.add(current.id);
        facts ??= await hubGet<Fact[]>(hub, "/v1/runs/" + current.id + "/why", hub.owner, signal);
        if (!facts) return;
        const approval = approvalOf(facts, current.id);
        if (!approval) break;
        const [id, card] = approval;
        if (card.state === "open") {
          records.status(task.id, "approval-" + id, "Run #" + current.id + " 等待审批，请由授权审批人处理飞书卡片。", current.id, id, false);
          return;
        }
        if (card.state === "closed" && !positive(card.answer_event)) {
          records.status(task.id, "final", "Run #" + current.id + " 审批已结案，任务未继续执行。", current.id, null, true);
          return;
        }
        const next = positive(card.answer_event) && continuation(facts, card.answer_event, current.id);
        if (!next) return;
        facts = await hubGet<Fact[]>(hub, "/v1/runs/" + next + "/why", hub.owner, signal);
        if (!facts) return;
        current = continuationRun(facts, next);
        if (!current) return;
        records.status(task.id, "", "", current.id, id, false);
      }
      const id = current.id;
      const prefix = "Run #" + id + " ";
      if (current.state === "queued" && current.attempts > 0) {
        records.status(task.id, "retry-" + id + "-" + current.attempts, prefix + "本次执行失败，等待中台重试。", id, task.approval, false);
        return;
      }
      if (current.state === "unknown") {
        records.status(task.id, "unknown-" + id, prefix + "执行状态未知，等待中台确认。", id, task.approval, false);
        return;
      }
      if (!["done", "nothing", "cancelled"].includes(current.state)) return;
      const failed = current.state === "cancelled" && /连续 \d+ 次没跑成/.test(current.summary ?? "");
      const status = failed ? "执行失败，已停止自动重试" : current.state === "cancelled" ? "已取消"
        : current.state === "nothing" ? "无需处理" : "已完成";
      const summary = publicSummary(current.summary?.split("\n").find((line) => line.trim()), privateValues, 260);
      records.status(task.id, "final", prefix + status + "。" + (summary ? "\n" + summary : ""), id, null, true);
    }

    async function poll() {
      while (!signal.aborted) {
        try {
          const settings = (await config()).config;
          if (settings && (settings.program ?? "lark-cli") === program) {
            const hub = await options.loadHub().catch(() => null);
            const active = records.active();
            if (hub && active.length) {
              const privateValues = await secrets(hub);
              await Promise.all(active.map((task) => {
                const user = settings.users.get(task.user);
                if (!user || (task.project && !user.projects.includes(task.project))) return records.abandon(task.id);
                if (!task.target && !inflight.has(task.id) && Date.now() - task.created > 120_000) {
                  return records.reply(task.id, "未确认任务创建，请检查本机中台。");
                }
                return track(task, hub, privateValues).catch(() => {});
              }));
            }
            for (const delivery of records.pending(Date.now())) {
              if (signal.aborted) break;
              const latest = (await config()).config;
              if (!latest || (latest.program ?? "lark-cli") !== program) break;
              const allowed = latest.users.get(delivery.user);
              if (!allowed || (delivery.project && !allowed.projects.includes(delivery.project))) {
                records.sent(delivery.id, delivery.stage);
                continue;
              }
              try {
                await replyFeishu(program, delivery.id, delivery.text, feishuId(delivery.id + ":" + delivery.stage), signal);
                records.sent(delivery.id, delivery.stage);
                if (state.error === connectionErrors.send) state.error = null;
              } catch {
                if (signal.aborted) break;
                state.error = connectionErrors.send;
                records.retry(delivery.id, delivery.stage, delivery.tries + 1);
              }
            }
          }
        } catch {
          state.error = "无法读取飞书任务跟踪记录。";
        }
        await wait(options.pollMs ?? 2500, undefined, { signal }).catch(() => {});
      }
    }

    const status = (error: unknown) => {
      const kind = error instanceof FeishuCliError ? error.kind : "connection";
      state.entry = kind === "connection" ? "reconnecting" : "setup";
      state.receive = kind === "authorization" ? "missing" : "unverified";
      state.error = connectionErrors[kind];
    };
    const polling = poll();
    try {
      while (!signal.aborted) {
        state.entry = "connecting";
        try {
          await consumeFeishu(program, signal, () => {
            state.entry = "listening";
            if (state.receive === "missing") state.receive = "unverified";
            if (state.error !== connectionErrors.send) state.error = null;
          }, receive);
        } catch (error) { if (!signal.aborted) status(error); }
        await wait(options.reconnectMs ?? 10_000, undefined, { signal }).catch(() => {});
      }
    } finally {
      await polling;
      records.close();
    }
  }
  return {
    status: () => ({ ...state }),
    start() {
      if (!closing) running ??= run().catch(() => {
        state.entry = "setup";
        state.error = "无法启动飞书聊天入口，请检查本机数据目录。";
      });
    },
    async close() { closing = true; stop.abort(); await running; },
  };
}

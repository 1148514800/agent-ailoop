import type { Fact, Run, State } from "../shared/types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T>(path: string, opts: { body?: object; csrf?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    signal: opts.signal, credentials: "same-origin", cache: "no-store",
    ...(opts.body && {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.csrf && { "x-console-csrf": opts.csrf }) },
      body: JSON.stringify(opts.body),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error ?? "请求失败，请稍后再试。");
  return data as T;
}

export const messageOf = (error: unknown) => error instanceof Error && !(error instanceof TypeError) ? error.message : "无法连接本地控制台。";
export const rulePath = (name: string, action: string) => "/rules/" + encodeURIComponent(name) + "/" + action;
export const active = (run: Run) => ["queued", "claimed", "unknown"].includes(run.state);
export const runStatus = (run: Run) => run.state === "claimed" && run.stopping ? "stopping" : run.state === "queued" && run.attempts > 0 ? "retry" : run.state;

export const runLabels: Record<string, [string, string]> = {
  claimed: ["执行中", "blue"], queued: ["排队中", "neutral"], retry: ["等待重试", "amber"],
  done: ["已完成", "green"], nothing: ["无需处理", "neutral"], cancelled: ["已停止", "neutral"],
  stopping: ["正在停止", "amber"], unknown: ["状态未知", "amber"],
};
export const cardLabels: Record<string, [string, string]> = {
  open: ["待处理", "amber"], decided: ["已回答", "blue"], done: ["已执行", "green"], closed: ["已结案", "neutral"],
};
export const factLabels: Record<string, string> = {
  rules: "规则更新", ingest: "收到事件", claimNext: "Worker 领取", started: "开始执行", finish: "收到回执",
  heartbeat: "Worker 心跳", workerSeen: "Worker 上报", channelSeen: "通道上报", delivered: "卡片已送达", failed: "卡片投递失败",
  answer: "卡片已回答", resolve: "卡片已结案", cancel: "请求停止", pauseRule: "规则暂停",
  resumeRule: "规则恢复", replayRule: "补跑跳过事件", runRule: "手动触发", tick: "定时检查",
  tell: "创建卡片", key: "访问权限变更", removeKey: "访问权限撤销",
};

export function fmtDate(value: string | number | null | undefined, tz: string, format: "full" | "short" | "time" = "short") {
  if (value == null || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz, hourCycle: "h23",
    ...(format === "full" ? { year: "numeric", month: "2-digit", day: "2-digit" } : format === "short" ? { month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit", minute: "2-digit", ...(format === "short" ? {} : { second: "2-digit" }),
  }).format(new Date(value));
}

export const amount = new Intl.NumberFormat("zh-CN");
export const cost = (value: number) => value > 0 && value < 0.01 ? "< US$0.01" : "US$" + value.toFixed(2);
export const agentName = (state: State, id: string) => state.agents.find((agent) => agent.id === id)?.name ?? id;
export const labelOf = (fact: Fact) => factLabels[fact.type] ?? "日志变更";

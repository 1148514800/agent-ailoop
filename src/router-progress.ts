import type { RouterChain } from "../shared/router.ts";
import type { Run } from "../shared/types.ts";
import { runLabels, runStatus } from "./data.ts";

export function stageStatus(run: Run) {
  if (run.state === "cancelled" && /^连续 \d+ 次没跑成/.test(run.summary)) return "failed";
  return runStatus(run);
}

export const stageLabel = (run: Run) => stageStatus(run) === "failed" ? "执行失败" :
  run.state === "cancelled" ? "已取消" : (runLabels[runStatus(run)] ?? runLabels.unknown)[0];

export function taskProgress(chain: RouterChain) {
  const states = chain.runs.map(({ run }) => stageStatus(run));
  const cards = chain.runs.flatMap(({ approvals }) => approvals);
  const waiting = cards.filter(({ state }) => state === "open");
  const unresolved = cards.some(({ answerEvent, runs }) => answerEvent !== null && !runs.length);
  const leaf = chain.runs.filter(({ approvals }) => approvals.every(({ runs }) => !runs.length));
  // Only completed branches with no unfinished handoff can supply an overall result.
  const result = (label: string, tone: string, finished = false) => ({ label, tone, finished, leaf, waiting });
  const followup = chain.runs.length > 1;
  if (chain.incomplete || !states.length) return result("执行链路待核对", "amber");
  if (states.includes("unknown")) return result("状态未知", "amber");
  if (waiting.length) return result("等待审批", "amber");
  if (unresolved) return result("等待后续任务 · 关联待核对", "amber");
  if (states.includes("stopping")) return result("正在停止", "amber");
  if (states.includes("claimed")) return result(followup ? "审批后继续执行" : "执行中", "blue");
  if (states.includes("retry")) return result("等待重试", "amber");
  if (states.includes("queued")) return result(followup ? "审批已处理 · 等待后续任务" : "排队中", "neutral");
  if (states.includes("failed")) return result("执行失败", "red", true);
  if (states.includes("cancelled") || cards.some(({ state, answerEvent }) => state === "closed" && !answerEvent))
    return result("已取消", "neutral", true);
  if (states.every((state) => state === "done" || state === "nothing"))
    return result(states.every((state) => state === "nothing") ? "无需处理" : "已完成", "green", true);
  return result("状态未知", "amber");
}

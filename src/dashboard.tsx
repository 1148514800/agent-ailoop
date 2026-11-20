import { Activity, ArrowDownRight, Bot, CalendarClock, Check, CircleHelp, Clock3, Layers3, ListTodo, Radio, RotateCcw, Timer, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Run, Spending, State } from "../shared/types.ts";
import { agentName, amount, cost, fmtDate, runLabels, runStatus } from "./data.ts";
import { Badge, Empty, Heading, Panel, TextLink } from "./ui.tsx";
import { RouterPanel } from "./router.tsx";
import type { Act } from "./runs.tsx";
import type { SendRouterMessage } from "./router.tsx";

export function RunBadge({ run }: { run: Run }) {
  const [label, tone] = runLabels[runStatus(run)] ?? ["未知", "neutral"];
  return <Badge tone={tone} dot>{label}</Badge>;
}

export function RunTable({ runs, state, compact, query = "" }: { runs: Run[]; state: State; compact?: boolean; query?: string }) {
  if (!runs.length) return <Empty title="没有符合条件的轮次" icon={ListTodo}>新的执行记录会显示在这里。</Empty>;
  return <div className="table-scroll"><table className="run-table">
    <thead><tr><th>轮次 / 规则</th><th>Agent</th><th>状态</th><th>{compact ? "最近更新" : "开始时间"}</th>{!compact && <><th>完成时间</th><th>结果</th></>}<th aria-label="查看详情" /></tr></thead>
    <tbody>{runs.map((run) => <tr key={run.id}>
      <td><a href={`#runs/${run.id}${query ? "?" + query : ""}`} className="run-name"><span>{run.rule}</span><small className="mono">#{run.id}{run.manual ? " · 手动" : ""}</small></a></td>
      <td><span className="agent-ref"><Bot size={14} />{agentName(state, run.agent)}</span></td><td><RunBadge run={run} /></td>
      <td className="table-date">{fmtDate(compact ? run.finishedAt ?? run.claimedAt ?? run.createdAt : run.claimedAt, state.timezone)}</td>
      {!compact && <><td className="table-date">{fmtDate(run.finishedAt, state.timezone)}</td><td className="table-result" title={run.error || run.summary}>{run.error || run.summary || "—"}</td></>}
      <td><a className="row-link" href={`#runs/${run.id}${query ? "?" + query : ""}`} aria-label={`查看第 ${run.id} 轮详情`}><ArrowDownRight size={16} /></a></td>
    </tr>)}</tbody>
  </table></div>;
}

function Metric({ icon: Icon, label, value, note, tone, to }: { icon: LucideIcon; label: string; value: number; note: string; tone: string; to: string }) {
  return <a className={`metric metric-${tone}`} href={to}>
    <div className="metric-label"><span className={`mini-icon tone-${tone}`}><Icon size={16} /></span>{label}<ArrowDownRight className="metric-arrow" size={15} aria-hidden="true" /></div>
    <strong>{amount.format(value)}</strong><small>{note}</small>
  </a>;
}

function UsageLine({ title, data, week }: { title: string; data: Spending; week: Spending }) {
  const tokenKnown = data.rounds > data.missingTokens, costKnown = data.rounds > data.missingCost;
  const ratio = (value: number, total: number) => total > 0 ? Math.round(100 * value / total) : 0;
  return <div className="usage-line">
    <div className="usage-period"><strong>{title}</strong><small>{amount.format(data.rounds)} 轮计入</small></div>
    <div className="usage-value"><div><strong>{!data.rounds ? "0" : tokenKnown ? amount.format(data.tokens) : "未上报"}</strong>{data.missingTokens > 0 && <small>{data.missingTokens} 轮缺失</small>}</div>
      <progress className="token-progress" aria-label={`${title}已报 Token 占七天已报量的比例`} max={100} value={ratio(data.tokens, week.tokens)} /></div>
    <div className="usage-value"><div><strong>{!data.rounds ? cost(0) : costKnown ? cost(data.cost) : "未上报"}</strong>{data.missingCost > 0 && <small>{data.missingCost} 轮缺失</small>}</div>
      <progress className="cost-progress" aria-label={`${title}已报费用占七天已报量的比例`} max={100} value={ratio(data.cost, week.cost)} /></div>
  </div>;
}

export function Dashboard({ state, sendRouter, act }: { state: State; sendRouter: SendRouterMessage; act: Act }) {
  const t = state.totals;
  const online = state.agents.filter((a) => a.online).length;
  const due = [
    ...state.lines.filter((line) => line.next && !line.paused).map((line) => ({ name: line.name, note: line.every, at: line.next!, id: "rule:" + line.id })),
    ...state.elsewhere.map((line) => ({ name: line.name, note: "外部定时 · " + line.where, at: line.next, id: "external:" + line.id })),
    ...state.timers.map((timer) => ({ name: timer.rule, note: timer.about || "到期复查", at: timer.at, id: `timer:${timer.rule}:${timer.lane}:${timer.key}` })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return <>
    <Heading title="运行总览" description="查看任务执行、待处理审批与用量。">
      <span className="date-chip"><CalendarClock size={16} />{new Intl.DateTimeFormat("zh-CN", { timeZone: state.timezone, dateStyle: "long" }).format(new Date(state.now))}</span>
    </Heading>
    <div className="metrics">
      <Metric icon={Activity} label="正在执行" tone="blue" value={t.running} note={t.unknown ? `${t.unknown} 轮状态未知` : "Worker 已领取"} to="#runs?status=claimed" />
      <Metric icon={Layers3} label="排队中" tone="violet" value={Math.max(0, t.queued - t.retrying)} note="等待 Worker 领取" to="#runs?status=queued" />
      <Metric icon={RotateCcw} label="等待重试" tone="amber" value={t.retrying} note="等待下次尝试" to="#runs?status=retry" />
      <Metric icon={Check} label="已完成" tone="green" value={t.done} note={`今天完成 ${amount.format(t.doneToday)} 轮`} to="#runs?status=done" />
      <Metric icon={CircleHelp} label="待处理卡片" tone="orange" value={state.cards.length} note={`${state.cards.filter((card) => card.kind === "ask").length} 张需要回复`} to="#approvals" />
    </div>
    <RouterPanel state={state} send={sendRouter} act={act} />
    <div className="dashboard-grid">
      <div className="stack">
        <Panel title="用量与费用" icon={Zap} extra={<span className="subtle-label">按轮次完成时间</span>}>
          {state.spending ? <div className="usage"><div className="usage-legend"><span>统计范围</span><span><i className="legend-token" /> Token</span><span><i className="legend-cost" /> 费用（美元）</span></div>
            <UsageLine title="今天" data={state.spending.today} week={state.spending.week} />
            <UsageLine title="最近 7 天" data={state.spending.week} week={state.spending.week} />
          </div> : <Empty title="中台未提供用量统计" icon={Zap} />}
        </Panel>
        <Panel title="最近任务" icon={ListTodo} extra={<TextLink to="#runs">查看全部</TextLink>}>
          <RunTable state={state} runs={state.runs.slice(0, 7)} compact />
        </Panel>
      </div>
      <div className="stack">
        <Panel title="Agent 连接" icon={Radio} extra={<TextLink to="#agents">{online}/{state.agents.length} 在线</TextLink>}>
          {state.agents.length ? <ul className="summary-list">{state.agents.slice(0, 4).map((agent) => <li key={agent.id}>
            <span className="mini-icon agent-icon"><Bot size={17} /></span><div><strong>{agent.name}</strong><small>{agent.worker} · {agent.use}</small></div>
            <Badge tone={agent.online ? "green" : "neutral"} dot>{agent.online ? "在线" : "离线"}</Badge>
          </li>)}</ul> : <Empty title="暂无 Agent" icon={Bot} />}
        </Panel>
        <Panel title="即将到期" icon={CalendarClock} extra={<TextLink to="#rules">查看规则</TextLink>}>
          {due.length ? <ul className="summary-list schedule-list">{due.slice(0, 5).map((item) => <li key={item.id}>
            <span className="mini-icon schedule-icon"><Clock3 size={16} /></span><div><strong>{item.name}</strong><small>{item.note}</small></div><time>{fmtDate(item.at, state.timezone)}</time>
          </li>)}</ul> : <Empty title="暂无待执行的定时任务" icon={Timer} />}
        </Panel>
      </div>
    </div>
  </>;
}

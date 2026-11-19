import { useState } from "react";
import { Activity, Bot, CalendarClock, Clock3, GitFork, History, Link2, ListTodo, Pause as PauseIcon, Play, Radio, RotateCcw, Server, Settings2, ShieldCheck, Workflow } from "lucide-react";
import type { Pause, Rule, State } from "../shared/types.ts";
import { agentName, amount, fmtDate, rulePath } from "./data.ts";
import type { Live } from "./live.ts";
import type { Act } from "./runs.tsx";
import { Badge, Button, Details, Drawer, Empty, Heading, Panel, TextLink } from "./ui.tsx";
import type { Action } from "./ui.tsx";

type ResumeResponse = { changed: boolean; paused?: Pause };
type ReplayResponse = { events: number[]; runs: number[] };

export function Rules({ state, name, close, act, choose, disabled, resumed, setResumed }: {
  state: State; name: string | null; close(): void; act: Act; choose(action: Action): void; disabled: boolean;
  resumed: Map<string, Pause>; setResumed(name: string, pause: Pause): void;
}) {
  const [scope, setScope] = useState("all");
  const rows = state.lines.filter((rule) => scope === "all" || (scope === "paused" ? !!rule.paused : !rule.paused));
  const selected = state.lines.find((rule) => rule.name === name);
  const olderPause = selected ? resumed.get(selected.name) : null;
  const pause = selected?.paused ?? olderPause;
  const relevant = state.skipped.filter((event) => event.rules.includes(selected?.name ?? ""));
  const textReason = { name: "reason", label: "说明（可选）", max: 200, placeholder: "给这次操作留一条记录" };

  function ruleAction(rule: Rule, action: "run" | "pause" | "resume" | "replay") {
    const timed = rule.every !== null;
    const title = "「" + rule.name + "」";
    if (action === "run") choose({
      title: "立即运行" + title + "？", description: "中台会按现有规则派活。同一事项已有排队轮次时，会合并进去。", confirm: "确认运行",
      fields: [{ name: "subject", label: "事件对象（可选）", placeholder: "例如 #42", max: 100 }, textReason],
      run: async ({ subject, reason }) => {
        const result = await act<{ run: number }> (rulePath(rule.name, action), { ...(subject && { subject }), ...(reason && { reason }) });
        return `已提交，第 ${result.run} 轮。`;
      },
    });
    if (action === "pause") choose({
      title: "暂停" + title + "？", description: timed ? "暂停期间将跳过定时触发，已开始的轮次继续执行。" : "暂停期间符合此规则的事件会被跳过，已开始的轮次继续执行。",
      confirm: "确认暂停", fields: [textReason, { name: "until", label: "自动恢复时间（浏览器时区，可选）", type: "datetime-local" }],
      run: async ({ reason, until }) => {
        await act(rulePath(rule.name, action), { ...(reason && { reason }), ...(until && { until: new Date(until).toISOString() }) });
        return "规则已暂停。";
      },
    });
    if (action === "resume") choose({
      title: "恢复" + title + "？", description: "恢复后会继续接收新事件和派发已有队列。暂停时跳过的事件可以另外补跑。", confirm: "确认恢复",
      run: async () => {
        const result = await act<ResumeResponse>(rulePath(rule.name, action), {});
        if (result.paused) setResumed(rule.name, result.paused);
        const skipped = result.paused?.skipped?.count ?? 0;
        return !result.changed ? "规则已处于启用状态。" : skipped ? `规则已恢复，有 ${skipped} 条跳过的事件可补跑。` : "规则已恢复。";
      },
    });
    if (action === "replay") {
      const previous = resumed.get(rule.name);
      choose({
        title: "补跑" + title + "？",
        description: "中台会接回起始时间以来这条规则跳过且尚未补跑的全部事件。事件可能合入已有轮次。",
        confirm: "确认补跑",
        fields: [{ name: "since", label: "起始时间（带时区的 ISO 时间）", placeholder: "2026-11-19T09:00:00+08:00", required: true, max: 45, value: previous?.since ?? "" }],
        run: async ({ since }) => {
          if (!/(Z|[+-]\d\d:\d\d)$/.test(since) || !Number.isFinite(Date.parse(since))) throw new Error("请填写带时区的 ISO 时间。");
          const result = await act<ReplayResponse>(rulePath(rule.name, action), { since });
          if (previous && Date.parse(since) <= Date.parse(previous.since)) setResumed(rule.name, { ...previous, skipped: { count: 0, events: [] } });
          return result.events.length ? `已补跑 ${result.events.length} 条事件，涉及 ${result.runs.length} 轮。` : "这段时间没有尚未补跑的事件。";
        },
      });
    }
  }

  return <>
    <Heading title="自动化规则" description="查看触发条件、运行统计和暂停期间跳过的事件。"><Badge tone="neutral">{state.lines.length} 条规则</Badge></Heading>
    <div className="tabs" aria-label="规则状态">
      <button aria-pressed={scope === "all"} onClick={() => setScope("all")}><Workflow size={16} />全部规则</button>
      <button aria-pressed={scope === "enabled"} onClick={() => setScope("enabled")}><Play size={16} />已启用</button>
      <button aria-pressed={scope === "paused"} onClick={() => setScope("paused")}><PauseIcon size={16} />已暂停</button>
    </div>
    <Panel title="中台规则" icon={GitFork}>
      {rows.length ? <div className="table-scroll"><table className="rules-table"><thead><tr><th>规则</th><th>Agent</th><th>触发类型</th><th>下次运行</th><th>状态</th><th>已完成</th></tr></thead>
        <tbody>{rows.map((rule) => <tr key={rule.id}>
          <td><a className="run-name" href={"#rules/" + encodeURIComponent(rule.name)}><span>{rule.name}</span><small>{rule.group === rule.name ? "默认组" : rule.group}</small></a></td>
          <td>{agentName(state, rule.agent)}</td>
          <td><span className="agent-ref">{rule.every ? <CalendarClock size={15} /> : <Radio size={15} />}{rule.every ? "定时" : "事件"}</span></td>
          <td className="table-date">{rule.paused ? "暂停中" : fmtDate(rule.next, state.timezone)}</td>
          <td><Badge tone={rule.paused ? "amber" : "green"} dot>{rule.paused ? "已暂停" : "已启用"}</Badge></td><td className="mono">{amount.format(rule.totals.done)}</td>
        </tr>)}</tbody></table></div> : <Empty title="没有符合条件的规则" icon={Workflow} />}
    </Panel>
    {state.elsewhere.length > 0 && <Panel title="外部定时任务" icon={CalendarClock} subtitle="由其他应用运行">
      <ul className="summary-list">{state.elsewhere.map((rule) => <li key={rule.id}><span className="mini-icon schedule-icon"><Clock3 size={16} /></span>
        <div><strong>{rule.name}</strong><small>{rule.where} · {rule.every}</small></div><time>{fmtDate(rule.next, state.timezone)}</time>
      </li>)}</ul>
    </Panel>}
    {name && <Drawer title="规则详情" close={close}>
      {selected ? <>
        <div className="drawer-title-row"><h3>{selected.name}</h3><Badge tone={selected.paused ? "amber" : "green"} dot>{selected.paused ? "已暂停" : "已启用"}</Badge></div>
        <Details items={[
          ["Agent", agentName(state, selected.agent)], ["并发组", selected.group],
          ["触发条件", selected.every || [selected.source, ...selected.types].join(" · ")],
          ["下次运行", selected.paused ? "暂停中" : fmtDate(selected.next, state.timezone, "full")],
          ["执行中 / 排队", selected.totals.running + " / " + selected.totals.queued],
          ["已完成 / 无需处理", selected.totals.done + " / " + selected.totals.nothing],
          ...(selected.skippedAt ? [["最近跳过的定时触发", fmtDate(selected.skippedAt, state.timezone, "full")] as [string, string]] : []),
        ]} />
        <div className="drawer-actions">
          <Button icon={Play} variant="primary" disabled={disabled || !!selected.paused} onClick={() => ruleAction(selected, "run")}>立即运行</Button>
          <Button icon={selected.paused ? Play : PauseIcon} disabled={disabled} onClick={() => ruleAction(selected, selected.paused ? "resume" : "pause")}>{selected.paused ? "恢复规则" : "暂停规则"}</Button>
          {selected.every === null && <Button icon={RotateCcw} disabled={disabled || !!selected.paused} onClick={() => ruleAction(selected, "replay")}>补跑跳过事件</Button>}
        </div>
        <TextLink to={"#runs?rule=" + encodeURIComponent(selected.name)}>查看任务记录</TextLink>
        {selected.paused && <div className="detail-block"><h4><PauseIcon size={16} /> 当前暂停</h4><Details items={[
          ["暂停起始时间", fmtDate(selected.paused.since, state.timezone, "full")], ["自动恢复", selected.paused.until ? fmtDate(selected.paused.until, state.timezone, "full") : "手动恢复"],
          ["原因", selected.paused.reason || "—"],
        ]} /></div>}
        {selected.every === null && <div className="detail-block"><h4><History size={16} /> 跳过的事件</h4>
          {pause?.skipped && <p className="muted">{selected.paused ? "本次暂停" : "最近一次记录的暂停"}还有 {pause.skipped.count} 条待补跑。{pause.skipped.count > 20 ? "下面最多显示最近 20 条。" : ""}</p>}
          {!pause?.skipped && relevant.length > 0 && <p className="muted">以下是最近跳过的事件，可能已经补跑。中台会按起始时间核对待补跑的事件。</p>}
          {(pause?.skipped?.events ?? relevant).length > 0 ? <ul className="plain-list">{(pause?.skipped?.events ?? relevant).map((event) => <li key={event.id}>
            <strong>{event.summary || event.type}</strong><small>#{event.id} · {event.source} · {event.type} · {fmtDate(event.receivedAt, state.timezone, "full")}</small>
          </li>)}</ul> : <p className="muted">暂无可显示的跳过事件。</p>}
          {selected.paused ? <p className="muted">恢复规则后可以补跑。</p> : <p className="muted">补跑时可以用暂停开始的时间为起点。</p>}
        </div>}
      </> : <Empty title="这条规则不在当前快照中" icon={Workflow} />}
    </Drawer>}
  </>;
}

export function Agents({ state }: { state: State }) {
  const online = state.agents.filter((agent) => agent.online).length;
  return <>
    <Heading title="Agent" description="查看配置中的 Agent、所属 Worker 和历史执行情况。"><Badge tone={online ? "green" : "neutral"} dot>{online}/{state.agents.length} 在线</Badge></Heading>
    <Panel title="已配置 Agent" icon={Bot} subtitle="在线状态来自所属 Worker 的心跳。">
      {state.agents.length ? <div className="table-scroll"><table className="agents-table"><thead>
        <tr><th>Agent</th><th>类型</th><th>Worker</th><th>在线状态</th><th>执行中</th><th>已完成</th><th>无需处理</th><th>最近心跳</th></tr>
      </thead><tbody>{state.agents.map((agent) => <tr key={agent.id}>
        <td><a className="run-name" href={"#runs?agent=" + encodeURIComponent(agent.id)}><span className="agent-ref"><Bot size={16} />{agent.name}</span><small className="mono">{agent.id}</small></a></td>
        <td><code>{agent.use}</code></td><td><code>{agent.worker}</code></td><td><Badge tone={agent.online ? "green" : "neutral"} dot>{agent.online ? "在线" : "离线"}</Badge></td>
        <td className="mono">{agent.totals.running}</td><td className="mono">{agent.totals.done}</td><td className="mono">{agent.totals.nothing}</td><td>{fmtDate(agent.seenAt, state.timezone)}</td>
      </tr>)}</tbody></table></div> : <Empty title="暂无已配置的 Agent" icon={Bot} />}
    </Panel>
  </>;
}

export function Settings({ live }: { live: Live }) {
  const { state, online, health, stream, lastError } = live;
  const tz = state?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <>
    <Heading title="运行设置" description="查看本机连接、运行版本和配置摘要。" />
    <div className="settings-grid">
      <Panel title="连接诊断" icon={Server} className="settings-panel" extra={<Badge dot tone={online ? "green" : "neutral"}>{online ? "中台在线" : online === null ? "检测中" : "中台离线"}</Badge>}>
        <Details items={[
          ["运行版本", <code>{health?.commit ?? "—"}</code>],
          ["事件订阅", stream === "live" ? "已连接" : stream === "retrying" ? "正在重连" : "等待快照"],
          ["快照序号", state ? <code>#{state.seq}</code> : "—"],
          ["快照时间", fmtDate(state?.now, tz, "full")], ["中台时区", state?.timezone ?? "—"],
          ["最近连接错误", lastError ? lastError.message + " · " + fmtDate(lastError.at, tz, "full") : "暂无"],
        ]} />
      </Panel>
      <Panel title="本机访问" icon={ShieldCheck} className="settings-panel">
        <Details items={[["控制台地址", <code>{location.origin}</code>], ["访问范围", "本机回环地址"], ["配置权限", "只读"]]} />
      </Panel>
      <Panel title="配置摘要" icon={Settings2} className="settings-panel">
        {state ? <ul className="summary-list">
          <li><span className="mini-icon tone-blue"><Bot size={17} /></span><div><strong>Agent</strong><small>{state.agents.map((agent) => agent.name).join("、") || "暂无"}</small></div><TextLink to="#agents">{state.agents.length} 个</TextLink></li>
          <li><span className="mini-icon tone-violet"><ListTodo size={17} /></span><div><strong>中台规则</strong><small>{state.lines.map((rule) => rule.name).join("、") || "暂无"}</small></div><TextLink to="#rules">{state.lines.length} 条</TextLink></li>
        </ul> : <Empty title="等待中台配置快照" icon={Activity} />}
      </Panel>
      <Panel title="已配置通道" icon={Link2} className="settings-panel">
        {state?.channels.length ? <ul className="summary-list">{state.channels.map((channel) => <li key={channel.id}>
          <span className="mini-icon tone-orange"><Radio size={16} /></span><div><strong>{channel.name}</strong><small>{channel.lastFailure ? channel.lastFailure.error : fmtDate(channel.seenAt, tz, "full")}</small></div>
          <Badge tone={channel.online ? "green" : "neutral"} dot>{channel.online ? "在线" : "离线"}</Badge>
        </li>)}</ul> : <Empty title={state ? "暂无配置通道" : "等待中台配置快照"} icon={Radio} />}
      </Panel>
    </div>
  </>;
}

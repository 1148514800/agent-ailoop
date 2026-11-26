import { useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, Clock3, FileText, History, Square, Workflow } from "lucide-react";
import type { Fact, FactRow, Run, State } from "../shared/types.ts";
import { active, agentName, amount, api, cost, fmtDate, labelOf, messageOf, runLabels, runStatus } from "./data.ts";
import { mergeRuns } from "./model.ts";
import { RunBadge, RunTable } from "./dashboard.tsx";
import { Badge, Button, Details, Drawer, Empty, ErrorLine, Heading, Panel, Select } from "./ui.tsx";
import { TaskMarkdown } from "./task-markdown.tsx";
import type { Action } from "./ui.tsx";

export type Act = <T>(path: string, body: object) => Promise<T>;

export function Runs({ state, query, navigate }: { state: State; query: URLSearchParams; navigate(hash: string): void }) {
  const [older, setOlder] = useState<Run[]>([]);
  const [next, setNext] = useState<number | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const cursor = next === undefined ? state.nextBefore : next;
  const section = query.get("scope") ?? "all";
  const agent = query.get("agent") ?? "";
  const rule = query.get("rule") ?? "";
  const status = query.get("status") ?? "";
  const all = mergeRuns(state.runs, older);
  const rows = all.filter((run) => {
    if ((section === "active" && !active(run)) || (section === "past" && active(run))) return false;
    return (!agent || run.agent === agent) && (!rule || run.rule === rule) && (!status || runStatus(run) === status);
  });
  const agents = [...new Set([...state.agents.map((item) => item.id), ...all.map((run) => run.agent), ...(agent ? [agent] : [])])];
  const rules = [...new Set([...state.lines.map((item) => item.name), ...all.map((run) => run.rule), ...(rule ? [rule] : [])])];
  const filter = (name: string, value: string) => {
    const params = new URLSearchParams(query);
    if (value && (name !== "scope" || value !== "all")) params.set(name, value); else params.delete(name);
    if (name === "scope") params.delete("status");
    navigate("#runs" + (params.size ? "?" + params : ""));
  };
  const load = async () => {
    if (!cursor || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError("");
    try {
      const page = await api<State>("/state?before=" + cursor, { signal: controller.signal });
      setOlder((previous) => mergeRuns(page.runs, previous));
      setNext(page.nextBefore);
    } catch (reason) { if (!controller.signal.aborted) setError(messageOf(reason)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };

  return <>
    <Heading title="任务轮次" description="查看运行状态、历史结果与每轮的执行过程。" />
    <div className="tabs" aria-label="轮次范围">
      <button aria-pressed={section === "all"} onClick={() => filter("scope", "all")}><Workflow size={16} />全部任务</button>
      <button aria-pressed={section === "active"} onClick={() => filter("scope", "active")}><Activity size={16} />进行中</button>
      <button aria-pressed={section === "past"} onClick={() => filter("scope", "past")}><History size={16} />已结束</button>
    </div>
    <Panel title="任务记录" extra={<span className="subtle-label">当前显示 {rows.length} 轮</span>}>
      <div className="filters">
        <Select label="Agent" value={agent} onChange={(v) => filter("agent", v)} choices={[["", "全部 Agent"], ...agents.map((id): [string, string] => [id, agentName(state, id)])]} />
        <Select label="规则" value={rule} onChange={(v) => filter("rule", v)} choices={[["", "全部规则"], ...rules.map((id): [string, string] => [id, id])]} />
        <Select label="状态" value={status} onChange={(v) => filter("status", v)} choices={[["", "全部状态"], ...Object.entries(runLabels).map(([id, [label]]): [string, string] => [id, label])]} />
      </div>
      <RunTable runs={rows} state={state} query={query.toString()} />
      {error && <div className="panel-pad"><ErrorLine>{error}</ErrorLine></div>}
      <div className="panel-foot"><span>{section === "active" ? "快照包含所有尚未结束的轮次" : cursor ? "筛选范围随历史加载扩大" : "已到历史记录末尾"}</span>
        {section !== "active" && cursor !== null && <Button icon={ChevronDown} busy={busy} onClick={() => void load()}>加载更早轮次</Button>}
      </div>
    </Panel>
  </>;
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }

function timelineOf(id: number, facts: Fact[]) {
  const versions = new Set<number>();
  const eventIds = new Set<number>();
  const history: { seq: number; at: number | string; title: string; detail: string; links: { id: number; label: string }[] }[] = [];
  let latest: FactRow | null = null;
  for (const fact of facts) {
    for (const { table, row } of fact.changes) {
      if (table === "run_events" && row?.run_id === id) eventIds.add(Number(row.event_id));
      if (table === "runs" && row?.id === id && typeof row.rules_version === "number") versions.add(row.rules_version);
    }
  }
  for (const fact of facts) {
    const changes: string[] = [];
    const links: { id: number; label: string }[] = [];
    let title = "";
    if (fact.type === "rules" && versions.has(fact.seq)) {
      title = "规则版本";
      changes.push("版本序号 #" + fact.seq);
    }
    for (const { table, row } of fact.changes) {
      if (!row) continue;
      if (table === "runs" && row.id === id) {
        const previous = latest;
        latest = row;
        if (!previous) title = "轮次创建";
        else if (fact.type !== "heartbeat" && fact.type !== "claimNext") title = labelOf(fact);
        if (row.claimed_at && (row.claimed_at !== previous?.claimed_at || (fact.type === "claimNext" && previous?.state !== "claimed" && row.state === "claimed"))) {
          title = "Worker 领取";
          changes.push("执行 Agent " + text(row.agent));
        }
        if (fact.type === "started" && row.session) changes.push("会话 " + text(row.session));
        if (row.error && (row.error !== previous?.error || row.attempts !== previous?.attempts)) {
          changes.push(text(row.error));
          if (row.state === "queued") title = "未完成，等待重试";
        }
        if (row.finished_at && row.finished_at !== previous?.finished_at) {
          if (row.state === "cancelled") title = "轮次已停止";
          else if (row.state === "nothing") title = "无需处理";
          else title = "轮次已完成";
          if (row.summary) changes.push(text(row.summary));
        }
        if (row.state === "unknown" && previous?.state !== "unknown") title = "Worker 心跳中断";
      }
      if (table === "events" && eventIds.has(Number(row.id))) {
        title ||= "触发事件";
        changes.push([text(row.type), row.subject && text(row.subject), row.summary && text(row.summary), row.detail && text(row.detail)].filter(Boolean).join(" · "));
      }
      if (table === "cards" && (row.run_id === id || eventIds.has(Number(row.answer_event)))) {
        title ||= "卡片更新";
        let selected = text(row.answer);
        if (!selected && typeof row.choice === "number" && typeof row.options === "string") {
          try { selected = text(JSON.parse(row.options)[row.choice]); } catch { /* Old data may omit options. */ }
        }
        changes.push([text(row.title), selected, text(row.result)].filter(Boolean).join(" · "));
        if (typeof row.id === "number") links.push({ id: row.id, label: "卡片 #" + row.id });
      }
      if (table === "timers" && fact.type === "finish" && fact.changes.some((change) => change.table === "runs" && change.row?.id === id)) {
        changes.push("安排复查 · " + (text(row.about) || text(row.key)));
      }
    }
    if (title || changes.length) history.push({ seq: fact.seq, at: fact.at, title: title || labelOf(fact), detail: changes.join("\n"), links });
  }
  const events = new Map<number, FactRow>();
  for (const { changes } of facts) for (const { table, row } of changes) {
    if (table === "events" && row && eventIds.has(Number(row.id))) events.set(Number(row.id), row);
  }
  return { history, latest, associated: [...events.values()].map((row) => ({
    source: text(row.source), type: text(row.type), summary: text(row.summary), subject: text(row.subject),
  })) };
}

export function RunDetail({ id, state, facts, close, act, choose, disabled }: {
  id: number; state: State; facts: Fact[]; close(): void; act: Act; choose(action: Action): void; disabled: boolean;
}) {
  const [why, setWhy] = useState<Fact[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const lastChange = facts.find((fact) => fact.changes.some((change) => (change.table === "runs" || change.table === "run_events" || change.table === "cards") &&
    (change.row?.id === id && change.table === "runs" || change.row?.run_id === id)))?.seq;
  useEffect(() => {
    const controller = new AbortController();
    void api<Fact[]>("/runs/" + id + "/why", { signal: controller.signal }).then((result) => {
      setWhy(result); setError("");
    }).catch((reason) => { if (!controller.signal.aborted) setError(messageOf(reason)); });
    return () => controller.abort();
  }, [id, retry, lastChange]);
  const current = state.runs.find((run) => run.id === id);
  const { history, latest, associated } = timelineOf(id, why ?? []);
  const runEvents = current?.events ?? associated;
  let recordedUsage: Run["usage"] = null;
  if (typeof latest?.usage === "string") {
    try { recordedUsage = JSON.parse(latest.usage); } catch { /* Old facts may not contain usage. */ }
  }
  const row = current ?? (latest ? {
    id, rule: text(latest.rule), agent: text(latest.agent), state: latest.state as Run["state"],
    attempts: Number(latest.attempts) || 0, stopping: !!latest.cancel_at, manual: !!latest.manual,
    createdAt: text(latest.created_at), claimedAt: text(latest.claimed_at) || null,
    finishedAt: text(latest.finished_at) || null, notBefore: text(latest.not_before) || null,
    session: text(latest.session) || null, error: text(latest.error), summary: text(latest.summary), usage: recordedUsage,
  } : null);
  const stop = () => {
    if (!row) return;
    choose({
      title: `停止第 ${id} 轮？`,
      description: row.state === "queued" ? "该轮会退出队列。" : "Worker 收到请求后会终止进程。以中台报告的最终状态为准。",
      confirm: "确认停止", danger: true,
      run: async () => {
        await act("/runs/" + id + "/cancel", {});
        setRetry((n) => n + 1);
        const message = row.state === "queued" ? "已提交取消排队。" : "已请求停止，等待 Worker 确认。";
        return message;
      },
    });
  };
  return <Drawer title={`第 ${id} 轮详情`} close={close}>
    {row && <><div className="drawer-title-row"><div><span className="subtle-label mono">#{id}</span><h3>{row.rule}</h3></div><RunBadge run={row as Run} /></div>
      <Details items={[
        ["Agent", agentName(state, row.agent)], ["创建时间", fmtDate(row.createdAt, state.timezone, "full")],
        ["开始时间", fmtDate(row.claimedAt, state.timezone, "full")], ["完成时间", fmtDate(row.finishedAt, state.timezone, "full")],
        ["会话编号", <code>{row.session || "—"}</code>], ["未完成次数", row.attempts],
        ...(runStatus(row as Run) === "retry" ? [["下次重试", fmtDate(row.notBefore, state.timezone, "full")] as [string, string]] : []),
        ...(row.usage ? [["用量", [
          row.usage.input !== undefined ? `输入 ${amount.format(row.usage.input)} Token` : null,
          row.usage.output !== undefined ? `输出 ${amount.format(row.usage.output)} Token` : null,
          row.usage.cost !== undefined ? cost(row.usage.cost) : null,
        ].filter(Boolean).join(" · ") || "未上报"] as [string, string]] : []),
      ]} />
      {row.summary && <div className="detail-block"><h4>结果</h4><p className="body-copy">{row.summary}</p></div>}
      {typeof latest?.detail === "string" && latest.detail &&
        <div className="detail-block"><h4>详细结果</h4><TaskMarkdown value={latest.detail} /></div>}
      {row.error && <ErrorLine>{row.error}</ErrorLine>}
      {["claimed", "queued"].includes(row.state) && !row.stopping && <Button icon={Square} variant="danger" onClick={stop} disabled={disabled}>停止任务</Button>}
    </>}
    {runEvents.length ? <div className="detail-block"><h4>关联事件</h4><ul className="plain-list">{runEvents.map((event, index) => <li key={index}>
      <strong>{event.summary || event.type}</strong><small>{event.source} · {event.type}{event.subject ? " · " + event.subject : ""}</small>
    </li>)}</ul></div> : null}
    <div className="detail-block"><h4><Clock3 size={16} /> 执行时间线</h4><p className="muted">时间线记录中台事实。当前协议未提供 Agent 的实时输出。</p>
      {error ? <><ErrorLine>{error}</ErrorLine><Button onClick={() => setRetry((n) => n + 1)}>重新读取</Button></>
        : !why ? <p className="loading-line" role="status">正在读取轮次时间线…</p>
        : history.length ? <ol className="timeline">{history.map((item) => <li key={item.seq}>
          <span className="timeline-dot" /><div><strong>{item.title}</strong><small>{fmtDate(item.at, state.timezone, "full")} · #{item.seq}</small>
            {item.detail && <p className="body-copy">{item.detail}</p>}
            {item.links.map((link) => <a key={link.id} className="inline-link" href={`#approvals/${link.id}`}>{link.label}</a>)}</div>
        </li>)}</ol> : <Empty title="这轮暂无时间线" icon={FileText} />}
    </div>
  </Drawer>;
}

export function EventFeed({ facts, state, connection }: { facts: Fact[]; state: State; connection: string }) {
  const [filter, setFilter] = useState("");
  const category = (fact: Fact) => fact.type;
  const types = [...new Set(facts.map(category))];
  const shown = facts.filter((fact) => !filter || category(fact) === filter);
  return <>
    <Heading title="事件动态" description="查看打开控制台后，中台写入的最新事实。" />
    <Panel title="实时事件" icon={Activity} extra={<Badge tone={connection === "live" ? "green" : "amber"} dot>{connection === "live" ? "实时连接" : "正在连接"}</Badge>}>
      <div className="filters"><Select label="事件类型" value={filter} onChange={setFilter} choices={[["", "全部类型"], ...types.map((type): [string, string] => [type, labelOf({ type } as Fact)])]} />
        <span className="subtle-label">保留本次连接最近 200 条</span></div>
      {shown.length ? <ul className="feed">{shown.map((fact) => {
        const run = fact.changes.find((change) => change.table === "runs" && change.row)?.row;
        const card = fact.changes.find((change) => change.table === "cards" && change.row)?.row;
        const event = fact.changes.find((change) => change.table === "events" && change.row)?.row;
        const pause = fact.changes.find((change) => change.table === "pauses");
        const presence = fact.changes.find((change) => change.table === "seen")?.row;
        const context = [event?.summary || event?.type, card?.title, run?.rule,
          pause?.row?.name ?? pause?.key, presence?.name].filter(Boolean).map(String);
        return <li key={fact.seq}><span className="mini-icon tone-neutral"><Activity size={16} /></span><div>
          <strong>{labelOf(fact)}</strong><small>{context.length ? context.join(" · ") : `${fact.changes.length} 项记录变更`}</small></div>
          <div className="feed-meta">{typeof run?.id === "number" && <a href={`#runs/${run.id}`} className="inline-link">轮次 #{run.id}</a>}
            <time>{fmtDate(fact.at, state.timezone)} · <span className="mono">#{fact.seq}</span></time></div></li>;
      })}</ul> : <Empty title={facts.length ? "没有符合条件的事件" : "正在等待新事件"} icon={Activity}>切换到任务详情可查看单轮的完整历史。</Empty>}
    </Panel>
  </>;
}

import { useEffect, useRef, useState } from "react";
import { Bell, ChevronRight, CircleCheck, CircleHelp, ClipboardCheck, MessageSquare, Send, Sparkles } from "lucide-react";
import type { Card, State } from "../shared/types.ts";
import { cardLabels, fmtDate, messageOf } from "./data.ts";
import type { Act } from "./runs.tsx";
import { Badge, Button, Empty, ErrorLine, Heading, Notice, Panel, TextLink } from "./ui.tsx";

function CardBody({ card, state, act, disabled, finish }: {
  card: Card; state: State; act: Act; disabled: boolean; finish(message: string, id: number): void;
}) {
  const [mode, setMode] = useState<"choice" | "text">("choice");
  const [choice, setChoice] = useState<number | null>(null);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ask = card.kind === "ask";
  const open = card.state === "open";
  const [label, tone] = cardLabels[card.state] ?? ["已处理", "neutral"];
  const answer = card.answer ?? (card.choice !== null ? card.options[card.choice] : null);
  const knownRule = state.lines.some((rule) => rule.name === card.rule);

  const send = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || disabled || !open) return;
    const words = response.trim();
    if (ask && (mode === "choice" ? choice === null : !words) || !ask && !words) return;
    setError(""); setBusy(true);
    try {
      const body = ask ? mode === "choice" ? { choice } : { text: words } : { reason: words };
      const result = await act<{ changed: boolean }>("/cards/" + card.id + (ask ? "/answer" : "/resolve"), body);
      finish(result.changed ? ask ? "答复已提交。" : "通知已结案。" : "这张卡片已在其他地方处理。", card.id);
    } catch (reason) { setError(messageOf(reason)); setBusy(false); }
  };
  return <section className="panel approval-detail" aria-labelledby="card-detail-title">
    <div className="approval-detail-head">
      <div className="approval-meta"><Badge tone={tone} dot>{label}</Badge><span className="mono">#{card.id}</span><time>{fmtDate(card.createdAt, state.timezone, "full")}</time></div>
      <h2 id="card-detail-title">{card.title}</h2>
      {(card.rule || card.lane) && <div className="context-line">{card.rule && (knownRule ? <TextLink to={"#rules/" + encodeURIComponent(card.rule)}>{card.rule}</TextLink> : <span>{card.rule}</span>)}{card.lane && <span className="mono">{card.lane}</span>}</div>}
    </div>
    <div className="approval-copy"><p className="body-copy">{card.text || "这张卡片没有附加说明。"}</p>
      {card.about && <details><summary>接续事项说明</summary><p className="body-copy">{card.about}</p></details>}</div>
    {open ? <form className="approval-form" onSubmit={(e) => void send(e)}>
      {ask ? <>
        <div className="approval-answer-head"><h3>你的回复</h3><div className="segmented" aria-label="回复方式">
          <button type="button" aria-pressed={mode === "choice"} onClick={() => setMode("choice")} disabled={busy}>选项</button>
          <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")} disabled={busy}>自定义文字</button>
        </div></div>
        {mode === "choice" ? <fieldset className="choices" disabled={busy || disabled}><legend className="sr-only">选择答复</legend>
          {card.options.map((option, index) => <label className="choice" key={index}><input type="radio" name="choice" checked={choice === index} onChange={() => setChoice(index)} />
            <span>{option}</span>{card.recommend === index && <Badge tone="orange"><Sparkles size={13} /> Agent 推荐</Badge>}
          </label>)}
        </fieldset> : <label className="field"><span>回复内容</span><textarea maxLength={4000} placeholder="告诉 Agent 你的决定…" value={response} onChange={(e) => setResponse(e.target.value)} disabled={busy || disabled} /></label>}
      </> : <label className="field"><span>处理结果</span><textarea maxLength={1000} placeholder="写一句处理结果…" value={response} onChange={(e) => setResponse(e.target.value)} disabled={busy || disabled} /></label>}
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="approval-footer"><span>{ask ? "提交后，中台会把答复交给对应事项。" : "结案后，这张通知将移到已处理。"}</span>
        <Button type="submit" variant="primary" icon={ask ? Send : CircleCheck} busy={busy} disabled={disabled || (ask && mode === "choice" ? choice === null : !response.trim())}>{ask ? "提交回复" : "确认结案"}</Button>
      </div>
    </form> : <div className="approval-form"><h3>处理记录</h3>
      {answer && <p className="body-copy">{answer}</p>}{card.result && <p className="body-copy">{card.result}</p>}
      <small className="muted">{[card.by, fmtDate(card.closedAt ?? card.decidedAt, state.timezone, "full")].filter(Boolean).join(" · ")}</small>
    </div>}
  </section>;
}

export function Approvals({ state, act, disabled, id, navigate }: {
  state: State; act: Act; disabled: boolean; id: number | null; navigate(hash: string): void;
}) {
  const [tab, setTab] = useState<"open" | "recent">(() => id && state.recentCards.some((card) => card.id === id) ? "recent" : "open");
  const [selection, setSelection] = useState<number | null>(null);
  const [success, setSuccess] = useState("");
  const [submitted, setSubmitted] = useState<Set<number>>(() => new Set());
  const shownDetail = useRef<HTMLDivElement>(null);
  const known = [...state.cards, ...state.recentCards].find((item) => item.id === id);
  const effectiveTab = id && known ? known.state === "open" ? "open" : "recent" : tab;
  const open = state.cards.filter((card) => !submitted.has(card.id));
  const list = effectiveTab === "open" ? open : state.recentCards;
  const card = id ? list.find((item) => item.id === id) ?? null : list.find((item) => item.id === selection) ?? list[0] ?? null;

  useEffect(() => {
    if (id && shownDetail.current && window.matchMedia("(max-width: 760px)").matches) shownDetail.current.scrollIntoView({ block: "start" });
  }, [id]);

  function finish(message: string, cardId: number) {
    setSubmitted((previous) => new Set([...previous, cardId]));
    setSuccess(message);
    setTab("open");
    setSelection(null);
    if (id) navigate("#approvals");
  }
  function switchTo(value: "open" | "recent") {
    setTab(value); setSelection(null);
    if (id) navigate("#approvals");
  }
  return <>
    <Heading title="审批中心" description="回复 Agent 的提问，处理需要你关注的通知。" />
    {success && <Notice>{success}</Notice>}
    <div className="tabs" aria-label="卡片状态">
      <button aria-pressed={effectiveTab === "open"} onClick={() => switchTo("open")}><CircleHelp size={16} />待处理 <small>{open.length}</small></button>
      <button aria-pressed={effectiveTab === "recent"} onClick={() => switchTo("recent")}><ClipboardCheck size={16} />已处理</button>
    </div>
    <div className="approval-grid">
      <Panel title={effectiveTab === "open" ? "待处理卡片" : "最近已处理"} extra={effectiveTab === "recent" && <span className="subtle-label">最多 20 张</span>}>
        {list.length ? <ul className="approval-list">{list.map((item) => <li key={item.id}><button type="button" aria-pressed={item.id === card?.id} onClick={() => {
          setSuccess("");
          if (id) navigate("#approvals/" + item.id);
          else setSelection(item.id);
          if (window.matchMedia("(max-width: 760px)").matches) shownDetail.current?.scrollIntoView({ block: "start" });
        }}>
          <span className={`mini-icon tone-${item.kind === "ask" ? "orange" : "blue"}`}>{item.kind === "ask" ? <CircleHelp size={17} /> : <Bell size={17} />}</span>
          <span className="approval-list-copy"><strong>{item.title}</strong><small>#{item.id} · {item.rule || (item.kind === "ask" ? "提问" : "通知")}</small></span><ChevronRight size={15} />
        </button></li>)}</ul> : <Empty title={effectiveTab === "open" ? "待处理卡片已清空" : "暂无已处理卡片"} icon={MessageSquare} />}
      </Panel>
      <div ref={shownDetail} className="approval-detail-slot">{card ? <CardBody key={card.id} card={card} state={state} act={act} disabled={disabled} finish={finish} />
        : <div className="panel"><Empty title={id ? "这张卡片未在当前快照中" : "没有可查看的卡片"} icon={ClipboardCheck}>{id ? "中台最多返回最近 20 张已处理卡片。" : undefined}</Empty></div>}</div>
    </div>
  </>;
}

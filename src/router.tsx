import { useRef, useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { ROUTER_MESSAGE_LIMIT } from "../shared/router.ts";
import type { RouterResult } from "../shared/router.ts";
import type { State } from "../shared/types.ts";
import { messageOf, runLabels, runStatus } from "./data.ts";
import { Badge, Button, ErrorLine, Panel, TextLink } from "./ui.tsx";

export type SendRouterMessage = (body: { requestId: string; message: string }) => Promise<RouterResult>;

export function RouterPanel({ state, send }: { state: State | null; send: SendRouterMessage }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RouterResult | null>(null);
  const [error, setError] = useState("");
  const request = useRef<{ requestId: string; message: string } | null>(null);
  const count = [...text].length;
  const canSend = !!text.trim() && count <= ROUTER_MESSAGE_LIMIT;
  const activeRun = result?.action === "execute" ? result.run : null;
  const current = activeRun && state?.runs.find((run) => run.id === activeRun.id);
  const run = current || activeRun;
  const status = run && (current ? runStatus(current) : run.state === "queued" && run.attempts > 0 ? "retry" : run.state);
  const [statusText, tone] = status ? runLabels[status] ?? ["状态未知", "neutral"] : ["", "neutral"];

  async function submit(body: NonNullable<typeof request.current>) {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const received = await send(body);
      setResult(received);
      setText("");
      if (received.action === "reply" || received.run) request.current = null;
    } catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }

  return <Panel title="AI Router" icon={Sparkles} className="router-panel">
    <form className="router-form" onSubmit={(event) => {
      event.preventDefault();
      if (!canSend || busy) return;
      const pending = request.current?.message === text ? request.current : { requestId: crypto.randomUUID(), message: text };
      request.current = pending;
      void submit(pending);
    }}>
      <label className="field">消息
        <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={busy}
          placeholder="例如，解释一个概念，或帮我修改 README 中的错别字" />
      </label>
      <div className="router-actions">
        <span className="muted">消息会发送到配置的模型。<span className={count > ROUTER_MESSAGE_LIMIT ? "router-limit" : ""}> {count}/{ROUTER_MESSAGE_LIMIT}</span></span>
        <Button type="submit" icon={Send} variant="primary" busy={busy} disabled={!canSend}>{busy ? "处理中…" : "发送"}</Button>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </form>
    {result && <div className="router-result" aria-live="polite">
      {result.action === "reply" ? <>
        <Badge tone="blue">直接回答</Badge><p className="body-copy">{result.answer}</p>
      </> : <>
        <div className="router-result-head">
          <Badge tone="violet">{result.needs_plan ? "建议先规划" : "直接执行"}</Badge>
          {run && <Badge tone={tone} dot>{statusText}</Badge>}
          <span className="muted">事件 #{result.eventId}</span>
          {run && <TextLink to={"#runs/" + run.id}>查看第 {run.id} 轮</TextLink>}
        </div>
        {result.status === "paused" && <p className="muted">规则已暂停，事件已记录，等待补跑。</p>}
        {result.status === "unmatched" && <p className="muted">事件已记录，未匹配 ai-router 规则。</p>}
        {run?.summary && <p className="body-copy">{run.summary}</p>}
        {run?.error && <ErrorLine>{run.error}</ErrorLine>}
        {!run && request.current && <Button disabled={!!text} onClick={() => { if (request.current) void submit(request.current); }}>刷新路由结果</Button>}
      </>}
    </div>}
  </Panel>;
}

import { useState } from "react";
import type { AgentScan, LocalAgentKind } from "../shared/router.ts";
import { api, messageOf } from "./data.ts";
import type { Act } from "./runs.tsx";
import { Badge, Button, ErrorLine, Notice, Panel } from "./ui.tsx";

export function LocalAgents({ act }: { act: Act }) {
  const [result, setResult] = useState<AgentScan | null>(null);
  const [selected, setSelected] = useState<LocalAgentKind | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const candidates = result?.agents.filter((item) => item.adapter) ?? [];
  async function scan() {
    setBusy(true);
    setError("");
    setNotice("");
    try { setResult(await api<AgentScan>("/router/agents/scan")); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <Panel title="本机 Agent" extra={<Button busy={busy} onClick={() => void scan()}>扫描本机 Agent</Button>}>
    {result && <div className="router-form">
      <ul className="summary-list">{result.agents.map((item) => <li key={item.kind}>
        <div><strong>{item.name}</strong>
          {item.program && <small className="local-agent-path">{item.program} · {item.version ?? "版本未知"}</small>}
          {item.registered.length > 0 && <small>已注册 {item.registered.join("、")}</small>}
          {item.program && <small>{item.executionVerified ? "已有成功执行记录" : "真实任务待验证"}</small>}
        </div>
        <Badge tone={item.adapter ? "green" : "neutral"}>
          {!item.program ? "未发现" : item.adapter ? "适配器检查通过" : "已安装，检查未通过"}
        </Badge>
        {item.adapter && <Button disabled={busy || !result.workers.length} onClick={() => setSelected(item.kind)}>添加 Agent</Button>}
      </li>)}</ul>
      {!result.workers.length && <p className="muted">本机配置中没有已登记的 Worker。</p>}
      {selected && <form key={selected} className="router-form" onSubmit={async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.currentTarget));
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const { agentId } = await act<{ agentId: string }>("/router/agents", { ...body, kind: selected });
          setSelected("");
          setNotice("中台已加载 " + agentId + "。");
          setResult(await api<AgentScan>("/router/agents/scan"));
        } catch (error) { setError(messageOf(error)); }
        finally { setBusy(false); }
      }}>
        <p>添加 {candidates.find((agent) => agent.kind === selected)?.name}</p>
        <div className="router-controls">
          <label className="field">Agent 名称<input name="name" maxLength={80} required /></label>
          <label className="field">本机 Worker<select name="worker">{result.workers.map((worker) => <option key={worker}>{worker}</option>)}</select></label>
          <label className="field">执行权限<select name="access" defaultValue="read">
            <option value="read">只读</option><option value="edit">工作区可写</option><option value="full">完全访问本机</option>
          </select></label>
        </div>
        <div className="router-actions"><Button onClick={() => setSelected("")} disabled={busy}>取消</Button>
          <Button type="submit" variant="primary" busy={busy}>注册 Agent</Button></div>
      </form>}
    </div>}
    {error && <ErrorLine>{error}</ErrorLine>}
    {notice && <Notice>{notice}</Notice>}
  </Panel>;
}

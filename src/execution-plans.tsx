import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { CODEX_EFFORTS, DSH_APIS, DSH_EFFORTS, TASK_TYPES, TOOL_CAPABILITIES } from "../shared/router.ts";
import type { DshCatalogEntry, ExecutionPlan, RouterProject, RouterResult, TaskRequirements, ToolCapability } from "../shared/router.ts";
import { api, messageOf } from "./data.ts";
import type { Act } from "./runs.tsx";
import { ModelPicker } from "./router-models.tsx";
import { Button, ErrorLine, Notice } from "./ui.tsx";

export const taskLabels = { coding: "编程", research: "研究", operation: "操作", general: "通用" };
const toolLabels = { browser_use: "浏览器操作", desktop_use: "桌面操作" };
const complexityLabels = { simple: "简单", complex: "复杂", any: "不限" };
type PlanData = { agents: { id: string; use: string; access: string; name: string }[]; plans: ExecutionPlan[]; dshCatalog: DshCatalogEntry[] };

const apiLabels = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Gemini API",
};

function DshFields({ plan, plans, catalog, busy }: {
  plan?: ExecutionPlan; plans: ExecutionPlan[]; catalog: DshCatalogEntry[]; busy: boolean;
}) {
  const source = plan?.provider?.source;
  const sourceId = source ? source.profile + "/" + source.id : "";
  const [mode, setMode] = useState(source ? "existing" : plan?.provider ? "custom" : "default");
  const [routeId, setRouteId] = useState(sourceId || (catalog[0] ? catalog[0].profile + "/" + catalog[0].id : ""));
  const route = catalog.find(({ profile, id }) => profile + "/" + id === routeId);
  const [modelId, setModelId] = useState(source ? plan?.model ?? "" : "");
  const model = route?.models.find(({ id }) => id === modelId);
  const problem = route?.reason ?? model?.reason ?? (route && modelId && !model ? "原模型已从 DSH 配置中移除。" :
    sourceId && !route ? "原供应商配置已移除或无法读取。已保存的任务仍可使用原版本。" : undefined);
  const [protocol, setProtocol] = useState(plan?.provider?.api ?? "openai-completions");
  const [baseURL, setBaseURL] = useState(plan?.provider?.baseURL ?? "");
  const [effort, setEffort] = useState(plan?.effort ?? "");
  const models = [...new Set(plans.flatMap((item) =>
    item.provider?.api === protocol && item.provider.baseURL === baseURL.trim().replace(/\/+$/, "") ? [item.model] : []))];
  return <>
    <label className="field">DSH 供应商
      <select name="dsh-provider" value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value); setEffort(""); }}>
        <option value="default">使用 DSH 内部默认模型</option>
        <option value="existing" disabled={!catalog.length && !source}>复用 DSH 已配置的供应商</option>
        <option value="custom">自定义供应商</option>
      </select>
    </label>
    {mode === "existing" && <>
      <label className="field">本机供应商
        <select name="dsh-existing" value={routeId} onChange={(event) => { setRouteId(event.target.value); setModelId(""); setEffort(""); }} required disabled={busy}>
          <option value="">选择供应商</option>
          {sourceId && !catalog.some(({ profile, id }) => profile + "/" + id === sourceId) && <option value={sourceId} disabled>原供应商配置已不可用</option>}
          {catalog.map(({ profile, id, api, reason }) => <option key={profile + "/" + id} value={profile + "/" + id}>
            {profile} · {id} · {api ? apiLabels[api] : "未知协议"}{reason ? "（不兼容）" : ""}
          </option>)}
        </select>
      </label>
      <label className="field">模型 ID
        <select name="model" aria-label="模型 ID" value={modelId} onChange={(event) => { setModelId(event.target.value); setEffort(""); }} required disabled={busy || !route || !!route.reason}>
          <option value="">选择模型 ID</option>
          {modelId && !model && <option value={modelId} disabled>{modelId}（已失效）</option>}
          {route?.models.map(({ id, reason }, index) => <option key={id + ":" + index} value={id}>{id}{reason ? "（不兼容）" : ""}</option>)}
        </select>
      </label>
      <label className="field">思考强度
        <select name="effort" value={effort} onChange={(event) => setEffort(event.target.value)} disabled={busy}>
          <option value="">使用 DSH 默认设置</option>
          {effort && !model?.efforts.some((level) => level === effort) && <option value={effort} disabled>{effort}（已失效）</option>}
          {model?.efforts.map((level) => <option key={level}>{level}</option>)}
        </select>
      </label>
      {problem && <ErrorLine>{problem}</ErrorLine>}
    </>}
    {mode === "custom" && <>
      <label className="field">API 协议
        <select name="dsh-api" value={protocol} onChange={(event) => setProtocol(event.target.value as typeof protocol)} disabled={busy}>
          {DSH_APIS.map((api) => <option key={api} value={api}>{apiLabels[api]}</option>)}
        </select>
      </label>
      <label className="field">Base URL
        <input type="url" name="dsh-base-url" value={baseURL} onChange={(event) => setBaseURL(event.target.value)}
          placeholder="https://gateway.example/v1" required disabled={busy} />
      </label>
      <label className="field">API Key
        <input type="password" name="dsh-key" autoComplete="new-password" maxLength={2048} disabled={busy}
          required={!plan?.provider} placeholder={plan?.provider ? "留空保留已保存的密钥" : "输入供应商密钥"} />
      </label>
      <ModelPicker initial={plan?.model ?? ""} models={models} defaultLabel="选择模型 ID"
        catalogLabel="列表来自此供应商已保存的方案。" disabled={busy} />
      <label className="field">思考强度
        <select name="effort" value={effort} onChange={(event) => setEffort(event.target.value)} disabled={busy}>
          <option value="">由供应商决定</option>
          {DSH_EFFORTS.map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      {protocol === "openai-completions" && <label className="field">思考格式
        <select name="dsh-thinking" defaultValue={plan?.provider?.thinkingFormat ?? "default"} disabled={busy}>
          <option value="default">标准 reasoning_effort</option><option value="deepseek">DeepSeek thinking</option>
        </select>
      </label>}
      {effort && <label className="field">API 强度值（可选）
        <input name="dsh-effort-value" maxLength={32} defaultValue={plan?.provider?.effortValue ?? ""}
          placeholder="留空时使用所选级别" disabled={busy} />
      </label>}
    </>}
  </>;
}

export function TaskFields({ requirements, change }: { requirements: TaskRequirements; change(value: TaskRequirements): void }) {
  return <div className="router-form">
    <label className="field">任务类型<select value={requirements.type}
      onChange={(event) => change({ ...requirements, type: event.target.value as TaskRequirements["type"] })}>
      {TASK_TYPES.map((type) => <option key={type} value={type}>{taskLabels[type]}</option>)}
    </select></label>
    <div className="router-modes">{TOOL_CAPABILITIES.map((tool) => <label key={tool}>
      <input type="checkbox" checked={requirements.tools.includes(tool)} onChange={(event) => change({ ...requirements,
        tools: event.target.checked ? [...requirements.tools, tool] : requirements.tools.filter((item) => item !== tool),
      })} />{toolLabels[tool]}</label>)}</div>
  </div>;
}

export function PlanDialog({ projects, act, close, changed }: {
  projects: RouterProject[]; act: Act; close(): void; changed(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<PlanData>();
  const [editing, setEditing] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const plan = data?.plans.find(({ id }) => id === editing);
  const agent = data?.agents.find(({ id }) => id === agentId);
  const tool: ToolCapability = "browser_use";
  const [probeRun, setProbeRun] = useState("");
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const reload = () => api<PlanData>("/router/plans").then(setData);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    void reload().catch((error) => setError(messageOf(error)));
    void api<{ models: string[] }>("/router/model-options").then(({ models }) => setCatalog(models)).catch(() => setCatalog([]));
    return () => element?.close();
  }, []);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="dialog" aria-labelledby="plan-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}>
    <div className="dialog-head"><h2 id="plan-title">执行方案</h2>
      <Button icon={X} className="icon-button" aria-label="关闭" onClick={close} disabled={busy} /></div>
    {!data && !error && <p className="muted">正在读取方案…</p>}
    {data && <>
      <label className="field">选择方案<select value={editing} disabled={busy} onChange={(event) => {
        setEditing(event.target.value);
        setAgentId(data.plans.find((plan) => plan.id === event.target.value)?.agentId ?? "");
        setError("");
        setNotice("");
        setProbeRun("");
      }}>
        <option value="">新增方案</option>
        {data.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}{plan.enabled ? "" : "（已禁用）"}</option>)}
      </select></label>
      <form key={editing} onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const apiKey = event.currentTarget.elements.namedItem("dsh-key") as HTMLInputElement | null;
        const [profile, id] = String(fields.get("dsh-existing") ?? "").split("/");
        const provider = fields.get("dsh-provider") === "existing" ? { existing: { profile, id } } :
          fields.get("dsh-provider") === "custom" ? {
          api: fields.get("dsh-api"), baseURL: fields.get("dsh-base-url"), key: fields.get("dsh-key"),
          thinkingFormat: fields.get("dsh-thinking") ?? "default", effortValue: fields.get("dsh-effort-value") ?? "",
        } : undefined;
        const body = { id: editing, name: fields.get("name"), agentId, model: fields.get("model") ?? "",
          effort: fields.get("effort") ?? "", tasks: fields.getAll("tasks"), projects: fields.getAll("projects"),
          complexity: fields.get("complexity"), priority: Number(fields.get("priority")), enabled: fields.has("enabled"), ...(provider && { provider }) };
        void perform(async () => {
          const saved = await act<{ id: string }>("/router/plans", body);
          if (apiKey) apiKey.value = "";
          await reload();
          setEditing(saved.id);
          setProbeRun("");
          changed();
          setNotice("执行方案已保存。");
        });
      }}>
        <label className="field">方案名称<input name="name" defaultValue={plan?.name} required maxLength={80} disabled={busy} /></label>
        <label className="field">绑定 Agent<select value={agentId} onChange={(event) => setAgentId(event.target.value)} required disabled={busy}>
          <option value="">选择已注册 Agent</option>
          {data.agents.map(({ id, name, access }) => <option key={id} value={id}>{name} · {access === "full" ? "完全访问" : access === "edit" ? "工作区可写" : "只读"}</option>)}
        </select></label>
        {agent?.use === "dsh" && <DshFields key={agent.id} plan={plan?.agentId === agentId ? plan : undefined} plans={data.plans} catalog={data.dshCatalog} busy={busy} />}
        {agent && agent.use !== "dsh" && <div key={agent.id}>
          <ModelPicker initial={plan?.agentId === agentId ? plan.model : ""} models={agent.use === "codex" ? catalog : []}
            defaultLabel={agent.use === "codex" ? undefined : "继承 Claude Code 默认"} disabled={busy} />
          <label className="field">思考强度<select name="effort" defaultValue={plan?.agentId === agentId ? plan.effort : ""} disabled={busy}>
            <option value="">继承 CLI 默认</option>
            {(agent.use === "codex" ? CODEX_EFFORTS : ["low", "medium", "high", "xhigh", "max"]).map((level) => <option key={level}>{level}</option>)}
          </select></label>
        </div>}
        <fieldset className="router-modes" disabled={busy}><legend>适用任务类型</legend>
          {TASK_TYPES.map((type) => <label key={type}><input type="checkbox" name="tasks" value={type}
            defaultChecked={plan?.tasks.includes(type) ?? type === "general"} />{taskLabels[type]}</label>)}
        </fieldset>
        <fieldset className="router-modes" disabled={busy}><legend>授权项目</legend>
          {projects.map((project) => <label key={project.id}><input type="checkbox" name="projects" value={project.id}
            defaultChecked={plan?.projects.includes(project.id)} />{project.name}</label>)}
        </fieldset>
        <div className="router-controls">
          <label className="field">复杂度偏好<select name="complexity" defaultValue={plan?.complexity ?? "any"} disabled={busy}>
            {Object.entries(complexityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="field">优先级<input type="number" name="priority" min={0} max={100} defaultValue={plan?.priority ?? 50} required disabled={busy} /></label>
        </div>
        <div className="dialog-actions">
          <label><input type="checkbox" name="enabled" defaultChecked={plan?.enabled ?? true} disabled={busy} />启用方案</label>
          <Button type="submit" variant="primary" busy={busy}>保存方案</Button>
        </div>
      </form>
      {plan && <div className="router-form">
        <strong>已验证工具能力</strong>
        <p>{plan.capabilities.map((tool) => toolLabels[tool]).join("、") || "暂无"}。桌面交互目前无法核验。</p>
        {plan.enabled && data.agents.some((agent) => agent.id === plan.agentId && agent.use === "codex") && <form
          onSubmit={(event) => {
            event.preventDefault();
            const projectId = new FormData(event.currentTarget).get("projectId");
            void perform(async () => {
              const result = await act<RouterResult>("/router/plans/probe", { id: plan.id, projectId, tool });
              if (result.action !== "execute" || !result.run) throw new Error("验证任务未创建轮次。");
              setProbeRun(String(result.run.id));
              setNotice("验证轮次 #" + result.run.id + " 已提交。完成后可核验工具调用。");
            });
          }}>
          <label className="field">验证项目<select name="projectId" required disabled={busy}>
            {projects.filter(({ id }) => plan.projects.includes(id)).map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <div className="dialog-actions"><Button type="submit" disabled={busy}>运行浏览器交互验证</Button></div>
        </form>}
        {data.agents.some((agent) => agent.id === plan.agentId && agent.use === "codex") && <form onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            await act("/router/plans/verify", { id: plan.id, runId: Number(probeRun), tool });
            await reload();
            changed();
            setNotice("已核验 #" + probeRun + " 的工具调用。");
          });
        }}>
          <label className="field">验证轮次<input type="number" min={1} value={probeRun} onChange={(event) => setProbeRun(event.target.value)}
            required disabled={busy} /></label>
          <div className="dialog-actions"><Button type="submit" disabled={busy}>核验 {toolLabels[tool]}</Button></div>
        </form>}

      </div>}
    </>}
    {error && <ErrorLine>{error}</ErrorLine>}
    {notice && <Notice>{notice}</Notice>}
  </dialog>;
}

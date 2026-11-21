import { useEffect, useRef, useState } from "react";
import { Plus, Send, Settings2, Sparkles } from "lucide-react";
import { MODEL_PROFILES, ROUTER_MESSAGE_LIMIT } from "../shared/router.ts";
import type { ProfileChoice, RouterMode, RouterProject, RouterResult } from "../shared/router.ts";
import type { State } from "../shared/types.ts";
import { api, messageOf, runLabels, runStatus } from "./data.ts";
import { ModelDetails, ModelProfileDialog, profileLabel } from "./router-models.tsx";
import { RouterProjectDialog } from "./router-project-dialog.tsx";
import type { Act } from "./runs.tsx";
import { Badge, Button, Confirm, ErrorLine, Notice, Panel, TextLink } from "./ui.tsx";

type RouterSubmission = { requestId: string; message: string; projectId: string; needsPlan?: boolean; executionProfile: ProfileChoice };
export type SendRouterMessage = (body: RouterSubmission, mode: RouterMode) => Promise<RouterResult>;
type Draft = { body: RouterSubmission; mode: RouterMode; projectName: string };
const modeLabel = { auto: "AI 自动判断", direct: "直接创建任务" };

export function RouterPanel({ state, send, act }: { state: State | null; send: SendRouterMessage; act: Act }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RouterResult | null>(null);
  const [error, setError] = useState("");
  const request = useRef<Draft | null>(null);
  const [projects, setProjects] = useState<RouterProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState<RouterMode>("auto");
  const [choice, setChoice] = useState<ProfileChoice>("auto");
  const [classifierModel, setClassifierModel] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [needsPlan, setNeedsPlan] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RouterProject | null>(null);
  const [notice, setNotice] = useState("");
  const [sent, setSent] = useState<Draft | null>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setProjectError("");
    void api<{ projects: RouterProject[]; classifierModel: string | null }>("/router/projects").then(({ projects, classifierModel }) => {
      if (!current) return;
      setProjects(projects);
      setClassifierModel(classifierModel);
      setProjectId((id) => projects.some((item) => item.id === id) ? id : projects.find((item) => item.id === "default")?.id ?? projects[0]?.id ?? "");
    }).catch((error) => {
      if (current) setProjectError(messageOf(error));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reload, state?.rulesRevision]);
  const project = projects.find((item) => item.id === projectId);
  const selected = choice === "fast" || choice === "strong" ? project?.profiles?.[choice] : project?.execution;
  const count = [...text].length;
  const canSend = !!project && !project.error && !projectError && !loading && !!text.trim() && count <= ROUTER_MESSAGE_LIMIT && (choice !== "fast" && choice !== "strong" || !!selected);
  const activeRun = result?.action === "execute" ? result.run : null;
  const current = activeRun && state?.runs.find((run) => run.id === activeRun.id);
  const run = current || activeRun;
  const status = run && (current ? runStatus(current) : run.state === "queued" && run.attempts > 0 ? "retry" : run.state);
  const [statusText, tone] = status ? runLabels[status] ?? ["状态未知", "neutral"] : ["", "neutral"];

  async function submit(draft: Draft) {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const received = await send(draft.body, draft.mode);
      setSent(draft);
      setResult(received);
      setText("");
      if (received.action === "reply" || received.run) request.current = null;
    } catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }

  return <Panel title="AI Router" icon={Sparkles} className="router-panel">
    <form className="router-form" onSubmit={(event) => {
      event.preventDefault();
      if (!canSend || busy || !project) return;
      const plan = mode === "direct" ? needsPlan : undefined;
      const previous = request.current;
      const pending = previous?.body.message === text && previous.body.projectId === projectId &&
        previous.mode === mode && previous.body.needsPlan === plan && previous.body.executionProfile === choice ? previous : {
          mode, projectName: project.name, body: { requestId: crypto.randomUUID(), message: text, projectId, needsPlan: plan, executionProfile: choice },
        };
      request.current = pending;
      void submit(pending);
    }}>
      <div className="router-controls">
        <label className="field">目标项目
          <select value={projectId} disabled={busy || loading || !projects.length} onChange={(event) => { setProjectId(event.target.value); setChoice(mode === "auto" ? "auto" : "default"); }}>
            {!projects.length && <option value="">{loading ? "正在加载项目…" : "没有可选项目"}</option>}
            {projects.map((item) => <option key={item.id} value={item.id}>
              {item.name} · {item.id}{item.error ? "（不可用）" : ""}
            </option>)}
          </select>
        </label>
        <div className="router-project-actions">
          <Button icon={Plus} disabled={busy} onClick={() => { setNotice(""); setAdding(true); }}>添加项目</Button>
          {project?.execution?.use === "codex" && <Button icon={Settings2} disabled={busy || loading} onClick={() => setEditingProfile(true)}>模型档位设置</Button>}
          {project?.directory && <Button disabled={busy || loading} onClick={() => { setNotice(""); setRemoving(project); }}>移除项目</Button>}
        </div>
        <fieldset className="router-modes" disabled={busy}>
          <legend>执行模式</legend>
          <label><input type="radio" name="router-mode" checked={mode === "auto"} onChange={() => { setMode("auto"); if (choice === "default") setChoice("auto"); }} />AI 自动判断</label>
          <label><input type="radio" name="router-mode" checked={mode === "direct"} onChange={() => { setMode("direct"); if (choice === "auto") setChoice("default"); }} />直接创建任务</label>
          {mode === "direct" && <label><input type="checkbox" checked={needsPlan} onChange={(event) => setNeedsPlan(event.target.checked)} />先规划再执行</label>}
        </fieldset>
        <label className="field">执行档位
          <select value={choice} disabled={busy || loading || !project} onChange={(event) => setChoice(event.target.value as ProfileChoice)}>
            {mode === "auto" && <option value="auto">{profileLabel.auto}</option>}
            <option value="default">{profileLabel.default}</option>
            {MODEL_PROFILES.map((profile) => <option key={profile} value={profile} disabled={!project?.profiles?.[profile]}>
              {profileLabel[profile]}{project?.profiles?.[profile] ? "" : "（未配置）"}
            </option>)}
          </select>
        </label>
      </div>
      {project?.execution && <div className="router-config">
        {mode === "auto" && <div><strong>Router 分类模型</strong><span>{classifierModel ?? "未配置或不可用"}</span></div>}
        {choice === "auto" && MODEL_PROFILES.some((profile) => project.profiles?.[profile])
          ? MODEL_PROFILES.flatMap((profile) => {
            const config = project.profiles?.[profile];
            return config ? [<div key={profile}><strong>{profileLabel[profile]}</strong><ModelDetails config={config} /></div>] : [];
          })
          : selected && <div><strong>{choice === "auto" ? "默认配置" : profileLabel[choice]}</strong><ModelDetails config={selected} /></div>}
      </div>}
      {(projectError || project?.error || (!loading && !projects.length)) && <div className="router-actions">
        <ErrorLine>{projectError || project?.error || "请先添加一个项目。"}</ErrorLine>
        <Button type="button" disabled={busy || loading} onClick={() => setReload((value) => value + 1)}>重新加载项目</Button>
      </div>}
      <label className="field">消息
        <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={busy}
          placeholder="例如，解释一个概念，或帮我修改 README 中的错别字" />
      </label>
      <div className="router-actions">
        <span className="muted">{mode === "auto" ? "消息会发送到配置的模型。" : "任务将交给所选项目执行。"}<span className={count > ROUTER_MESSAGE_LIMIT ? "router-limit" : ""}> {count}/{ROUTER_MESSAGE_LIMIT}</span></span>
        <Button type="submit" icon={Send} variant="primary" busy={busy} disabled={!canSend}>{busy ? "处理中…" : mode === "direct" ? "创建任务" : "发送"}</Button>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      {notice && <Notice>{notice}</Notice>}
    </form>
    {editingProfile && project && <ModelProfileDialog project={project} act={act} close={() => setEditingProfile(false)} saved={(profile) => {
      setEditingProfile(false);
      setLoading(true);
      setReload((value) => value + 1);
      setNotice(profileLabel[profile] + " 档位已保存。");
    }} />}
    {adding && <RouterProjectDialog act={act} close={() => setAdding(false)} added={(id) => {
      setAdding(false);
      setLoading(true);
      setProjectId(id);
      setChoice(mode === "auto" ? "auto" : "default");
      setReload((value) => value + 1);
      setNotice("项目已添加。");
    }} />}
    {removing && <Confirm disabled={false} close={() => setRemoving(null)} complete={(message) => {
      setLoading(true);
      setRemoving(null);
      setChoice(mode === "auto" ? "auto" : "default");
      setReload((value) => value + 1);
      setNotice(message);
    }} action={{
      title: "移除项目",
      description: `将「${removing.name}」（${removing.directory}）从 AI Router 的目标项目中移除。工程文件、规则和历史记录会保留。`,
      confirm: "确认移除", danger: true,
      async run() {
        await act("/router/projects/remove", { projectId: removing.id });
        return "项目已从 AI Router 移除。";
      },
    }} />}
    {result && <div className="router-result" aria-live="polite">
      {sent && <div className="muted">{sent.projectName} · {modeLabel[sent.mode]}</div>}
      {result.action === "reply" ? <>
        <Badge tone="blue">直接回答</Badge><p className="body-copy">{result.answer}</p>
      </> : <>
        <div className="router-result-head">
          <Badge tone="violet">{result.needs_plan ? sent?.mode === "direct" ? "先规划再执行" : "建议先规划" : "直接执行"}</Badge>
          {run && <Badge tone={tone} dot>{statusText}</Badge>}
          <span className="muted">事件 #{result.eventId}</span>
          {run && <TextLink to={"#runs/" + run.id}>查看第 {run.id} 轮</TextLink>}
        </div>
        {result.execution && <div className="router-config">
          <div><strong>选择档位</strong><span>{profileLabel[result.execution_profile ?? "default"]}</span></div>
          <div><strong>先规划</strong><span>{result.needs_plan ? "是" : "否"}</span></div>
          <ModelDetails config={result.execution} />
        </div>}
        {result.status === "paused" && <p className="muted">规则已暂停，事件已记录，等待补跑。</p>}
        {result.status === "unmatched" && <p className="muted">事件已记录，未匹配所选项目的规则。</p>}
        {run?.summary && <p className="body-copy">{run.summary}</p>}
        {run?.error && <ErrorLine>{run.error}</ErrorLine>}
        {!run && request.current && <Button disabled={!!text} onClick={() => { if (request.current) void submit(request.current); }}>刷新路由结果</Button>}
      </>}
    </div>}
  </Panel>;
}

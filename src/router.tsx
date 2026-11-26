import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, CircleAlert, ClipboardCheck, Copy, Folder, LoaderCircle, Plus, Settings2 } from "lucide-react";
import { MODEL_PROFILES, ROUTER_MESSAGE_LIMIT } from "../shared/router.ts";
import type { ExecutionConfig, ProfileChoice, RouterChain, RouterHistory, RouterMode, RouterResult, TaskRequirements } from "../shared/router.ts";
import type { State } from "../shared/types.ts";
import { api, ApiError, fmtDate, messageOf, runLabels } from "./data.ts";
import { PlanDialog, TaskFields } from "./execution-plans.tsx";
import { configValue, ModelDetails, ModelProfileDialog, profileLabel } from "./router-models.tsx";
import { taskTitle, WorkspaceNotice } from "./router-workspace.tsx";
import type { RouterWorkspace } from "./router-workspace.tsx";
import type { Act } from "./runs.tsx";
import { Button, ErrorLine, TextLink } from "./ui.tsx";
import { stageLabel, stageStatus, taskProgress } from "./router-progress.ts";
import { responseText, TaskMarkdown } from "./task-markdown.tsx";

type RouterSubmission = { requestId: string; message: string; projectId: string; projectScope: string; needsPlan?: boolean; executionProfile: ProfileChoice; requirements?: TaskRequirements };
export type SendRouterMessage = (body: RouterSubmission, mode: RouterMode, signal: AbortSignal) => Promise<RouterResult>;
type Draft = { body: RouterSubmission; mode: RouterMode; projectName: string };
type Received = { draft: Draft; result: RouterResult; epoch: AbortSignal };
type TaskRecord = { history: RouterHistory; chain: RouterChain };
type Target = { visit: number; epoch: AbortSignal; id: string };
type HistoryPage = { visit: number; epoch: AbortSignal; record?: TaskRecord | null; error?: string };

const defaults: TaskRequirements = { type: "general", tools: [], complexity: "simple" };
const modeLabel = { auto: "自动判断", direct: "直接执行" };
const planLabel = (choice?: ProfileChoice) => choice === "auto" ? "自动选型" : choice === "fast" || choice === "strong" ? profileLabel[choice] : "默认方案";
const configHint = (config?: ExecutionConfig) => config ? [config.name, config.model, config.effort].filter(Boolean).join(" · ") : "";

function ResultText({ value, label }: { value: string; label: string }) {
  const [feedback, setFeedback] = useState("");
  return <section className="task-response">
    <div className="task-section-heading"><h2>{label}</h2>
      {responseText(value) && <button className="task-quiet" type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(responseText(value)); setFeedback("已复制"); }
        catch { setFeedback("无法复制"); }
      }}><Copy size={14} />{feedback || "复制结果"}</button>}
    </div>
    {responseText(value) ? <TaskMarkdown value={value} /> : <p className="muted">当前没有可显示的内容。</p>}
  </section>;
}

export function RouterPanel({ visible, reset, id, state, epoch, visit, setTaskTarget, work, send, act, add, navigate, setPending, online }: {
  visible: boolean; reset: number; id: number | null; state: State | null; epoch: AbortSignal; visit: number; setTaskTarget(target: Target): void; work: RouterWorkspace;
  send: SendRouterMessage; act: Act; add(): void; navigate(route: string): void; setPending(value: boolean): void; online: boolean | null;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Draft | null>(null);
  const pending = useRef<Draft | null>(null);
  const inFlight = useRef<AbortSignal | null>(null);
  const [uncertain, setUncertain] = useState<Draft | null>(null);
  const pendingEpoch = useRef<AbortSignal | null>(null);
  const suspectSubmit = useRef(false);
  const [explicitTarget, setExplicitTarget] = useState<(Target & { scope: string })>();
  const [picked, setPicked] = useState<HistoryPage>();
  const [received, setReceived] = useState<Received | null>(null);
  const [submissions, setSubmissions] = useState<Record<number, Received>>({});
  const [error, setError] = useState("");
  const [mode, setMode] = useState<RouterMode>("auto");
  const [choice, setChoice] = useState<ProfileChoice>("auto");
  const [requirements, setRequirements] = useState<TaskRequirements>(defaults);
  const [needsPlan, setNeedsPlan] = useState(false);
  const [editing, setEditing] = useState<"plans" | "profiles" | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [retry, setRetry] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const { projects } = work;
  const page = picked?.visit === visit && picked.epoch === epoch ? picked : undefined;
  const task = page?.record;
  const history = task?.history;
  const explicit = explicitTarget?.visit === visit && explicitTarget.epoch === epoch ? explicitTarget : undefined;
  const project = !id ? work.project : explicit
    ? projects.find((item) => item.id === explicit.id && item.scope === explicit.scope && !item.error)
    : projects.find((item) => item.id === history?.projectId && item.scope === history.projectScope && !item.error);
  const projectId = project?.id ?? (!id ? work.projectId : "");
  const historicalProject = history && projects.find((item) => item.id === history.projectId && item.scope === history.projectScope);
  function selectProject(value: string) {
    const next = projects.find((item) => item.id === value && !item.error);
    if (!next?.scope) return;
    if (id) setExplicitTarget({ visit, epoch, id: next.id, scope: next.scope });
    work.setProjectId(next.id);
  }
  useLayoutEffect(() => {
    if (!visible || !id) return;
    setTaskTarget({ visit, epoch, id: projectId });
    if (projectId) work.setProjectId(projectId);
  }, [id, projectId, visible, visit, epoch, setTaskTarget, work.setProjectId]);
  const custom = project?.plans?.find((plan) => "plan:" + plan.id === choice);
  const selected = choice.startsWith("plan:") ? custom?.execution
    : choice === "fast" || choice === "strong" ? project?.profiles?.[choice] : project?.execution;
  const count = [...text].length;
  const canSend = !!project?.scope && !project.error && !work.projectError && !work.loading && online === true && !uncertain &&
    !!text.trim() && count <= ROUTER_MESSAGE_LIMIT && !!selected;

  useEffect(() => {
    if (!uncertain && (!pending.current || pendingEpoch.current === epoch)) setText("");
    setReceived(null); setError(""); setMode("auto"); setChoice("auto");
    setRequirements(defaults); setNeedsPlan(false); setAdvanced(false);
    if (pendingEpoch.current === epoch) { pending.current = null; suspectSubmit.current = false; }
  }, [reset]);
  useEffect(() => {
    if (!work.loading && !selected && choice !== "default" && choice !== "auto") setChoice(mode === "auto" ? "auto" : "default");
  }, [selected, work.loading, choice, mode]);
  useLayoutEffect(() => {
    if (!visible || !field.current) return;
    const element = field.current;
    element.style.height = "0px";
    element.style.height = Math.min(224, element.scrollHeight) + "px";
  }, [text, visible]);
  useEffect(() => {
    if (visible && !id && matchMedia("(pointer: fine)").matches) field.current?.focus({ preventScroll: true });
  }, [visible, id, reset]);
  useEffect(() => {
    if (!advanced) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !options.current?.contains(event.target)) setAdvanced(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAdvanced(false);
        options.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [advanced]);

  useEffect(() => {
    setPicked(undefined);
    setSubmissions({});
    setReceived(null);
    setEditing(null);
    setExplicitTarget(undefined);
    setError("");
    if (pending.current && pendingEpoch.current !== epoch) {
      setUncertain(pending.current);
      pending.current = null;
    }
    if (inFlight.current && inFlight.current !== epoch) {
      inFlight.current = null;
      setBusy(null);
      setPending(false);
    }
  }, [epoch, setPending]);
  useEffect(() => {
    if (!id || !visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, epoch]);
    void api<TaskRecord | null>("/runs/" + id + "/why?view=router-chain", { signal }).then((record) => {
      if (!signal.aborted) setPicked({ visit, epoch, record });
    }).catch((reason) => {
      if (signal.aborted) return;
      const error = reason instanceof ApiError && reason.status === 404
        ? "当前中台没有这个 Run。请从侧栏打开当前中台的任务。" : messageOf(reason);
      setPicked((previous) => ({
        visit, epoch, error,
        record: reason instanceof ApiError && reason.status === 404 ? undefined :
          previous?.visit === visit && previous.epoch === epoch ? previous.record : undefined,
      }));
    });
    return () => controller.abort();
  }, [id, retry, visit, visible, epoch, state?.seq]);
  const candidate = id ? submissions[id] : received;
  const submission = candidate?.epoch === epoch && !epoch.aborted ? candidate : undefined;
  const result = submission?.result;
  const draft = busy ?? submission?.draft;
  const dispatch = result?.action === "execute" ? result : undefined;
  const run = task?.chain.runs[0]?.run ?? history?.run ?? dispatch?.run;
  const execution = history?.execution ?? dispatch?.execution;
  const original = busy?.body.message || history?.message || draft?.body.message;
  const projectName = historicalProject?.name ?? draft?.projectName ?? history?.projectId;
  const progress = task && taskProgress(task.chain);
  const chainUnavailable = !!page?.error || task === null;
  const provisional = run && (run.state === "queued" || run.state === "claimed") ? runLabels[run.state] : null;
  const thread = !!(id || result || busy);
  const canPlan = needsPlan && mode === "direct";
  const projectOptions = projects.map((item) => <option value={item.id} key={item.id} disabled={!!item.error}>
    {item.name}{item.error ? "（不可用）" : ""}
  </option>);

  async function submit(request: Draft, refresh = false) {
    if (inFlight.current || epoch.aborted || uncertain) return;
    inFlight.current = epoch;
    pendingEpoch.current = epoch;
    pending.current = request;
    setPending(true);
    setBusy(request); setError(""); setAdvanced(false);
    const startLocation = location.hash;
    try {
      const response = await send(request.body, request.mode, epoch);
      if (epoch.aborted) return;
      const entry = { draft: request, result: response, epoch };
      setReceived(entry);
      if (!refresh) setText("");
      if (response.action === "execute" && response.run) {
        const runId = response.run.id;
        setSubmissions((previous) => ({ ...previous, [runId]: entry }));
        if (location.hash === startLocation) navigate("#router/" + runId);
      } else if (location.hash === startLocation) navigate("#router");
      pending.current = null;
      suspectSubmit.current = false;
    } catch (reason) {
      if (!epoch.aborted) {
        suspectSubmit.current ||= !(reason instanceof ApiError) || reason.status === 408 || reason.status >= 500 ||
          /提交结果未知/.test(messageOf(reason));
        const note = suspectSubmit.current ? " 上次提交结果未确认。相同内容与设置可按原请求重试。" : "";
        setError(messageOf(reason) + note);
      }
    } finally {
      if (inFlight.current === epoch && !epoch.aborted) {
        inFlight.current = null;
        setBusy(null);
        setPending(false);
      }
    }
  }

  const changeMode = (value: RouterMode) => {
    setMode(value);
    if (value === "direct" && choice === "auto") setChoice("default");
    if (value === "auto" && choice === "default") setChoice("auto");
  };

  return <section className={"router-panel task-workbench " + (thread ? "task-thread" : "task-blank")} aria-label="AI Router 工作台">
    {!thread && <div className="task-welcome">
      <img src="/mark.svg" alt="" width="48" height="48" />
      <h1>今天想完成什么？</h1>
      <div className="task-project-select"><Folder size={15} /><select aria-label="目标项目" value={projectId}
        disabled={!projects.length || work.loading} onChange={(event) => selectProject(event.target.value)}>
        {!projects.length && <option value="">{work.loading ? "正在加载项目…" : "没有可用项目"}</option>}
        {projectOptions}
      </select><ChevronDown size={14} /></div>
    </div>}
    {thread && <article className="router-result">
      <header className="task-title">
        <h1>{taskTitle(original ?? "", id ? "任务 #" + id : "新任务")}</h1>
        <p>{[history ? "原任务项目 " + projectName : projectName, !busy && run ? "Run #" + run.id : null].filter(Boolean).join(" · ")}
          {history && !work.loading && !historicalProject && <span> · 历史项目（已移除或目录已变更）</span>}</p>
      </header>
      {original && <div className="task-message">{original}</div>}
      {busy ? <p className="task-progress" role="status"><LoaderCircle size={16} className="spin" />
        {busy.mode === "auto" ? "正在判断任务…" : "正在确认任务…"}
      </p> : result?.action === "reply" ? <ResultText key={result.answer} value={result.answer} label="AI 回复" /> :
      (dispatch || run) ? <>
        {execution && <details className="task-execution">
          <summary><Settings2 size={15} /><span>{history?.planName || dispatch?.planName || planLabel(dispatch?.execution_profile)}</span>
            <small>{execution.name} · {configValue(execution, "model")} · {configValue(execution, "effort")}</small><ChevronDown size={15} /></summary>
          <ModelDetails config={execution} />
        </details>}
        <div className="task-run-state" aria-live="polite">
          {run && <p><Check size={15} />任务已创建</p>}
          {(history?.needsPlan ?? dispatch?.needs_plan) && <p><Check size={15} />先规划再执行</p>}
          {run && <p className={"task-state task-state-" + (chainUnavailable ? "amber" : progress?.tone ?? provisional?.[1] ?? "neutral")}>
            <span className={"task-dot task-dot-" + (chainUnavailable ? "amber" : progress?.tone ?? provisional?.[1] ?? "neutral")} />
            {chainUnavailable ? "执行链路待核对" : progress?.label ?? provisional?.[0] ?? "正在核对执行链路…"}
          </p>}
          {progress?.waiting.map((card) => <p key={card.id} className="task-state-amber"><ClipboardCheck size={16} />
            <TextLink to={"#approvals/" + card.id}>等待审批 · {card.title || "卡片 #" + card.id}</TextLink></p>)}
          {!run && dispatch && <p className="task-state-amber"><CircleAlert size={15} />{dispatch.status === "paused" ? "规则已暂停，等待补跑。" : "事件已记录，未匹配规则。"} 事件 #{dispatch.eventId}</p>}
        </div>
        {page?.error && <><ErrorLine>{page.error}</ErrorLine><Button onClick={() => setRetry((value) => value + 1)}>重新读取任务</Button></>}
        {task?.chain.incomplete && !page?.error && <Button onClick={() => setRetry((value) => value + 1)}>重新核对执行链路</Button>}
        {task && progress && <details className="task-stages">
          <summary>执行过程 · {task.chain.runs.length} 轮</summary>
          <ol>{task.chain.runs.map(({ run: stage, approvals }) => <li key={stage.id}>
            <div className="task-stage-head"><strong>Run #{stage.id} · {stageLabel(stage)}</strong>
              <TextLink to={"#router/" + id + "?details=" + stage.id}>查看第 {stage.id} 轮详情</TextLink></div>
            {stage.summary && <div className="body-copy">{responseText(stage.summary)}</div>}
            {stage.error && <div className="muted">{responseText(stage.error)}</div>}
            {approvals.map((card) => <div key={card.id} className="muted">
              {card.state === "open" ? "等待审批" : card.state === "closed" && !card.answerEvent ? "审批已结案" : "审批已处理"}
              {" · " + card.title}
              {card.runs.length ? " → " + card.runs.map((child) => "Run #" + child).join("、") :
                card.answerEvent ? " · 后续 Run 待核对" : ""}
            </div>)}
          </li>)}</ol>
        </details>}
        {!page?.error && progress?.finished && progress.leaf.filter(({ run: stage }) => stage.summary || stage.detail).map(({ run: stage }) =>
          <ResultText key={stage.id + stage.summary} value={[stage.summary, stage.detail].filter(Boolean).join("\n\n")}
            label={(stage.detail ? "任务结果" : "任务摘要") + (progress.leaf.length > 1 ? " · Run #" + stage.id : "")} />)}
        {task?.chain.runs.filter(({ run: stage }) => stage.error).map(({ run: stage }) => <ErrorLine key={stage.id}>
          {task.chain.runs.length > 1 && "Run #" + stage.id + " · "}{responseText(stage.error)}
          {stageStatus(stage) === "retry" && stage.notBefore && state && <small> · {fmtDate(stage.notBefore, state.timezone, "full")} 后可重试</small>}
        </ErrorLine>)}
        {run && <TextLink to={"#router/" + run.id + "?details=1"}>查看执行详情</TextLink>}
        {!run && dispatch && submission && <Button onClick={() => void submit(submission.draft, true)}>刷新路由结果</Button>}
      </> : page?.error ? <><ErrorLine>{page.error}</ErrorLine><Button onClick={() => setRetry((value) => value + 1)}>重新读取任务</Button></> :
      task === null && id ? <p className="muted">该轮没有可确认的 Router 记录。<TextLink to={"#runs/" + id}>查看轮次详情</TextLink></p> :
      <p className="muted" role="status">正在读取任务…</p>}
    </article>}
    <div className="task-compose-wrap">
      <form className="task-composer" onSubmit={(event) => {
        event.preventDefault();
        if (!canSend || inFlight.current || !project?.scope || epoch.aborted) return;
        const hash = location.hash.split("?")[0];
        if (id ? hash !== "#router/" + id : hash !== "" && hash !== "#router") return;
        const body = { message: text, projectId, projectScope: project.scope, needsPlan: mode === "direct" ? needsPlan : undefined, executionProfile: choice,
          requirements: mode === "direct" ? { ...requirements, complexity: canPlan ? "complex" as const : "simple" as const } : undefined };
        const previous = pending.current;
        const requestId = previous?.body.requestId;
        const unchanged = previous?.mode === mode && JSON.stringify(previous.body) === JSON.stringify({ requestId, ...body });
        if (!unchanged && previous && suspectSubmit.current) {
          setError("上次提交结果未确认。请保留原内容、项目和执行方案重试，或核对轮次或事件后开始新任务。");
          return;
        }
        const request = unchanged ? previous : { body: { requestId: crypto.randomUUID(), ...body }, mode, projectName: project.name };
        pending.current = request;
        void submit(request);
      }}>
        <textarea ref={field} aria-label="消息" rows={2} value={text} readOnly={!!busy} onChange={(event) => setText(event.target.value)}
          placeholder={thread ? "输入下一项独立任务…" : "描述你的任务，或提出一个问题…"} onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }} />
        <div className="composer-tools">
          <div className="composer-select"><select aria-label="执行模式" disabled={!!busy} value={mode} onChange={(event) => changeMode(event.target.value as RouterMode)}>
            <option value="auto">{modeLabel.auto}</option><option value="direct">{modeLabel.direct}</option>
          </select><ChevronDown size={13} /></div>
          <div className="composer-select composer-profile"><select aria-label="执行方案" value={choice} disabled={!!busy || !project || work.loading}
            onChange={(event) => setChoice(event.target.value as ProfileChoice)}>
            {mode === "auto" && <option value="auto">自动选型</option>}
            <option value="default" title={configHint(project?.execution)}>默认方案</option>
            {MODEL_PROFILES.map((level) => <option key={level} value={level} disabled={!project?.profiles?.[level]}
              title={configHint(project?.profiles?.[level])}>{profileLabel[level]}{project?.profiles?.[level] ? "" : "（未配置）"}</option>)}
            {project?.plans?.map((plan) => <option key={plan.id} value={"plan:" + plan.id} title={configHint(plan.execution)}>{plan.name}</option>)}
          </select><ChevronDown size={13} /></div>
          <div className="composer-options" ref={options}>
            <button className="task-quiet task-gear" type="button" aria-label="高级选项" title="高级选项" aria-expanded={advanced}
              disabled={!!busy} onClick={() => setAdvanced(!advanced)}><Settings2 size={17} /></button>
            {advanced && <div className="advanced-panel" aria-label="高级设置">
              <h2>高级选项</h2>
              {mode === "direct" ? <>
                <label className="option-check"><input type="checkbox" checked={needsPlan} onChange={(event) => setNeedsPlan(event.target.checked)} />先规划再执行</label>
                <TaskFields requirements={requirements} change={setRequirements} />
              </> : <p className="muted">由 Router 判断是否先规划，以及需要的任务类型和工具能力。</p>}
              <div className="advanced-config">
                {mode === "auto" && <p>分类模型 <strong>{work.classifierModel ?? "未配置或不可用"}</strong></p>}
                {choice === "auto" && <p className="muted">以下为默认方案，实际配置以匹配结果为准。</p>}
                {selected && <ModelDetails config={selected} />}
              </div>
              <div className="advanced-actions">
                <Button disabled={!projects.length} onClick={() => { setAdvanced(false); setEditing("plans"); }}>执行方案</Button>
                {project?.execution?.use === "codex" && <Button onClick={() => { setAdvanced(false); setEditing("profiles"); }}>模型档位设置</Button>}
              </div>
            </div>}
          </div>
          <div className="composer-send">
            {count >= ROUTER_MESSAGE_LIMIT * .85 && <span className={count > ROUTER_MESSAGE_LIMIT ? "router-limit" : "muted"}>{count}/{ROUTER_MESSAGE_LIMIT}</span>}
            <button type="submit" className="task-send" aria-label={busy ? "处理中" : "发送"} title="发送（Enter）" disabled={!canSend || !!busy}>
              {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>
      </form>
      {thread && <div className="composer-note">
        {!!projects.length && <label className="task-composer-project">下一项任务
          <span className="task-project-select"><Folder size={13} /><select aria-label="下一项任务的项目" value={projectId} disabled={!!busy || work.loading} onChange={(event) => selectProject(event.target.value)}>
            {!projectId && <option value="">{work.loading ? "正在加载项目…" : "请选择目标项目"}</option>}
            {projectOptions}
          </select><ChevronDown size={13} /></span></label>}
        {id && !project && !work.loading && <span className="task-state-amber">请明确选择下一项任务的目标项目。</span>}
        <span>{result?.action === "reply" ? "聊天仅保留在当前页面，刷新后清除。 " : ""}每次发送都是独立请求。</span>
      </div>}
      {uncertain && <div className="task-project-error"><ErrorLine>中台数据已变更，原提交结果未知。请先核对轮次或事件，再开始新任务。</ErrorLine>
        <Button onClick={() => { setUncertain(null); suspectSubmit.current = false; setText(""); }}>已核对，清空草稿</Button></div>}
      {error && <ErrorLine>{error}</ErrorLine>}
      {(work.projectError || project?.error) && <div className="task-project-error"><ErrorLine>{work.projectError || project?.error}</ErrorLine>
        <Button onClick={work.reloadProjects}>重新加载项目</Button></div>}
      {!work.loading && !projects.length && <Button icon={Plus} onClick={add}>添加项目</Button>}
      <WorkspaceNotice work={work} />
    </div>
    {editing === "plans" && <PlanDialog projects={projects} act={act} close={() => setEditing(null)} changed={work.reloadProjects} />}
    {editing === "profiles" && project && <ModelProfileDialog project={project} act={act} close={() => setEditing(null)} saved={(profile) => {
      setEditing(null); work.reloadProjects(); work.setNotice(profileLabel[profile] + " 档位已保存。");
    }} />}
  </section>;
}

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, ClipboardCheck, LayoutDashboard, ListTodo, LoaderCircle, Menu, Moon, PanelLeft, RefreshCw, Server, Settings2, SquarePen, Sun, Workflow, X } from "lucide-react";
import type { Pause } from "../shared/types.ts";
import { Approvals } from "./approvals.tsx";
import { Dashboard } from "./dashboard.tsx";
import { RouterPanel } from "./router.tsx";
import type { SendRouterMessage } from "./router.tsx";
import { ProjectDialogs, ProjectSidebar, useRouterWorkspace } from "./router-workspace.tsx";
import type { RouterProject, RouterResult } from "../shared/router.ts";
import { api, ApiError, fmtDate, messageOf } from "./data.ts";
import { useLive } from "./live.ts";
import { Agents, Rules, Settings } from "./manage.tsx";
import { EventFeed, RunDetail, Runs } from "./runs.tsx";
import type { Act } from "./runs.tsx";
import { Badge, Button, Confirm, Empty, ErrorLine, Heading, Notice } from "./ui.tsx";
import type { Action } from "./ui.tsx";
import "./styles.css";

const navigation = [
  { id: "overview", name: "运行总览", icon: LayoutDashboard },
  { id: "runs", name: "任务轮次", icon: ListTodo },
  { id: "rules", name: "自动化规则", icon: Workflow },
  { id: "agents", name: "Agent", icon: Bot },
  { id: "approvals", name: "审批中心", icon: ClipboardCheck },
  { id: "events", name: "事件动态", icon: Activity },
  { id: "settings", name: "运行设置", icon: Settings2 },
] as const;

const defaultRoute = { id: "router", name: "新建任务" } as const;
type Session = { csrf: string };
type Theme = "dark" | "light";

function readRoute() {
  const address = location.hash.slice(1).split("?");
  const [path, part] = address[0].split("/");
  let detail: string | null = null;
  if (part) try { detail = decodeURIComponent(part); } catch { /* The invalid detail stays closed. */ }
  return { page: navigation.find((item) => item.id === path) ?? defaultRoute, detail, query: new URLSearchParams(address[1]) };
}

function positiveId(value: string | null) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function Brand() {
  return <div className="brand"><img src="/mark.svg" alt="" width="39" height="39" /><div><strong>Autoloop</strong><small>AGENT 工作台</small></div></div>;
}

function Shell({ csrf, expired, theme, setTheme }: { csrf: string; expired(): void; theme: Theme; setTheme(value: Theme): void }) {
  const [route, setRoute] = useState(readRoute);
  const [mobileNav, setMobileNav] = useState(false);
  const [rail, setRail] = useState(() => localStorage.getItem("autoloop-sidebar") !== "closed");
  const [reset, setReset] = useState(0);
  const [routerPending, setRouterPending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RouterProject | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [toast, setToast] = useState("");
  const [resumed, setResumed] = useState<Map<string, Pause>>(() => new Map());
  const live = useLive(expired);
  const { state, online } = live;
  const work = useRouterWorkspace(state, live.generation);
  useEffect(() => { localStorage.setItem("autoloop-sidebar", rail ? "open" : "closed"); }, [rail]);
  useEffect(() => {
    if (!mobileNav) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileNav(false); };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [mobileNav]);
  useEffect(() => {
    const onHash = () => { setRoute(readRoute()); setMobileNav(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => { setResumed(new Map()); }, [live.generation]);
  const navigate = (hash: string) => {
    if (location.hash !== hash) location.hash = hash;
    else setMobileNav(false);
  };
  const freshTask = () => {
    if (routerPending) return;
    setReset((value) => value + 1);
    navigate("#router");
  };
  const addProject = () => { setMobileNav(false); setAdding(true); };
  const write: Act = async (path, body) => {
    try {
      return await api(path, { body, csrf });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expired();
      throw new Error(messageOf(error));
    } finally {
      await live.refresh();
    }
  };
  const sendRouter: SendRouterMessage = async (body, mode) => {
    try {
      const result = await api<RouterResult>(mode === "direct" ? "/router/task" : "/router/message", { body, csrf });
      if (result.action === "execute") void live.refresh();
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expired();
      throw error;
    }
  };
  const writeDisabled = online !== true || !!live.error;
  const pid = route.page.id;
  const detailId = positiveId(route.detail);
  const upToDate = state && !live.error;
  return <div className={`layout ${rail ? "" : "rail-closed"} ${pid === "router" ? "router-layout" : ""}`}>
    {mobileNav && <button className="nav-scrim" type="button" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`} aria-label="工作台侧栏">
      <a className="brand-link" href="#router" aria-label="Autoloop 新建任务" onClick={(event) => { event.preventDefault(); freshTask(); }}><Brand /></a>
      <div className="rail-primary"><button type="button" className="rail-command rail-new" disabled={routerPending} onClick={freshTask}>
        <SquarePen size={16} /><span>新建任务</span></button>
      <ProjectSidebar work={work} active={pid === "router" ? detailId : null} select={(project) => {
        if (routerPending) return;
        work.setProjectId(project.id); freshTask();
      }} open={(id) => navigate("#router/" + id)} add={addProject} remove={(project) => { setMobileNav(false); setRemoving(project); }} />
      </div>
      <nav aria-label="主导航" className="rail-management">
        <div className="rail-section-label">管理</div>
        {navigation.map(({ id, name, icon: Icon }) =>
          <a key={id} href={"#" + id} aria-current={pid === id ? "page" : undefined} onClick={() => setMobileNav(false)}>
            <Icon size={16} /><span>{name}</span>{id === "approvals" && !!state?.cards.length && <small className="nav-count">{state.cards.length}</small>}</a>)}
      </nav>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><Button className="icon-button mobile-menu" icon={Menu} aria-label="打开导航" aria-expanded={mobileNav} onClick={() => setMobileNav(!mobileNav)} />
          <Button className="icon-button desktop-menu" icon={PanelLeft} aria-label={rail ? "折叠侧栏" : "展开侧栏"} aria-expanded={rail} onClick={() => setRail(!rail)} />
          <strong>{pid === "router" && detailId ? "任务详情" : route.page.name}</strong></div>
        <div className="top-actions">
          <Badge tone={online ? "green" : online === false ? "red" : "neutral"} dot>{online ? "中台在线" : online === false ? "中台离线" : "检测中"}</Badge>
          <span className="top-divider" />
          <Button className="icon-button" icon={RefreshCw} busy={live.refreshing} aria-label="刷新状态" title="刷新状态" onClick={() => void live.refresh()} />
          <Button className="icon-button" icon={theme === "dark" ? Sun : Moon} aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} title={theme === "dark" ? "切换浅色主题" : "切换深色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
        </div>
      </header>
      <main className={pid === "router" ? "content router-content" : "content"} id="main-content">
        {live.error && <ErrorLine>{live.error}{state && ` 当前显示 ${fmtDate(state.now, state.timezone, "full")} 的快照。`}</ErrorLine>}
        <div className="router-host" hidden={pid !== "router"}>
          <RouterPanel visible={pid === "router"} reset={reset} id={pid === "router" ? detailId : null} state={state} facts={live.facts}
            work={work} send={sendRouter} act={write} add={addProject} navigate={navigate} setPending={setRouterPending} online={online} />
        </div>
        {pid === "router" && detailId && route.query.get("details") === "1" && state &&
          <RunDetail key={detailId} id={detailId} state={state} facts={live.facts} act={write}
            close={() => navigate("#router/" + detailId)} choose={setAction} disabled={writeDisabled} />}
        {pid === "router" ? null : pid === "settings" ? <Settings live={live} /> : state ? <>
          {pid === "overview" && <Dashboard state={state} newTask={freshTask} />}
          {pid === "runs" && <Runs key={live.generation} state={state} query={route.query} navigate={navigate} />}
          {pid === "rules" && <Rules state={state} name={route.detail} close={() => navigate("#rules")} act={write} choose={setAction}
            disabled={writeDisabled} resumed={resumed} setResumed={(name, pause) => setResumed((previous) => new Map(previous).set(name, pause))} />}
          {pid === "agents" && <Agents state={state} act={write} />}
          {pid === "approvals" && <Approvals key={live.generation} state={state} act={write} disabled={writeDisabled} id={detailId} navigate={navigate} />}
          {pid === "events" && <EventFeed facts={live.facts} state={state} connection={live.stream} />}
          {pid === "runs" && detailId && <RunDetail key={detailId} id={detailId} state={state} facts={live.facts} act={write}
            close={() => navigate("#runs" + (route.query.size ? "?" + route.query : ""))} choose={setAction}
            disabled={writeDisabled} />}
        </> : <>
          <Heading title={route.page.name} description="连接本机 Agent Autoloop 中台。" />
          <div className="panel">{live.error ? <Empty title="暂时无法读取中台" icon={Server}><Button icon={RefreshCw} onClick={() => void live.refresh()} busy={live.refreshing}>重新连接</Button></Empty>
            : <Empty title="正在加载中台状态" icon={LoaderCircle}>正在读取当前快照…</Empty>}</div>
        </>}
        {upToDate && pid !== "router" && <footer className="content-foot"><span>Agent Autoloop</span><span>快照 <code>#{state.seq}</code> <span className="foot-dot">·</span> {state.timezone}</span></footer>}
      </main>
    </div>
    <ProjectDialogs work={work} act={write} adding={adding} removing={removing} close={() => { setAdding(false); setRemoving(null); }}
      added={(id) => { work.setProjectId(id); freshTask(); }} />
    {toast && <div className="toast"><Notice>{toast}<button type="button" onClick={() => setToast("")} aria-label="关闭提示"><X size={15} /></button></Notice></div>}
    {action && <Confirm action={action} disabled={writeDisabled} close={() => setAction(null)} complete={(message) => { setAction(null); setToast(message); }} />}
  </div>;
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem("autoloop-theme") === "light" ? "light" : "dark");
  const [csrf, setCsrf] = useState("");
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const expired = useCallback(() => {
    setCsrf("");
    setFailure("");
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("autoloop-theme", theme);
  }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Session>("/session", { signal: controller.signal }).then((session) => {
      if (typeof session.csrf !== "string" || !session.csrf) throw new Error("无法打开本机会话，请重启 Web 控制台。");
      setCsrf(session.csrf);
    }).catch((reason) => { if (!controller.signal.aborted) setFailure(messageOf(reason)); });
    return () => controller.abort();
  }, [attempt]);
  if (csrf) return <Shell csrf={csrf} expired={expired} theme={theme} setTheme={setTheme} />;
  return <main className="session-entry">
    {failure ? <><ErrorLine>{failure}</ErrorLine><Button icon={RefreshCw} onClick={expired}>重新连接</Button></>
      : <p role="status" className="loading-line"><LoaderCircle className="spin" size={17} /> 正在连接本地控制台…</p>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);

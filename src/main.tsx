import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bot, ChevronRight, ClipboardCheck, LayoutDashboard, ListTodo, LoaderCircle, LockKeyhole, Menu, Moon, RefreshCw, Server, Settings2, Sun, Workflow, X } from "lucide-react";
import type { Pause } from "../shared/types.ts";
import { Approvals } from "./approvals.tsx";
import { Dashboard } from "./dashboard.tsx";
import { RouterPanel } from "./router.tsx";
import type { SendRouterMessage } from "./router.tsx";
import type { RouterResult } from "../shared/router.ts";
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

const defaultRoute = navigation[0];
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
  return <div className="brand"><img src="/mark.svg" alt="" width="39" height="39" /><div><strong>Autoloop</strong><small>管理控制台</small></div></div>;
}

function Shell({ csrf, expired, theme, setTheme }: { csrf: string; expired(): void; theme: Theme; setTheme(value: Theme): void }) {
  const [route, setRoute] = useState(readRoute);
  const [mobileNav, setMobileNav] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [toast, setToast] = useState("");
  const [resumed, setResumed] = useState<Map<string, Pause>>(() => new Map());
  const live = useLive(expired);
  const { state, online } = live;
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
  return <div className="layout">
    {mobileNav && <button className="nav-scrim" type="button" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <a className="brand-link" href="#overview" aria-label="Autoloop 运行总览" onClick={() => setMobileNav(false)}><Brand /></a>
      <div className="workspace-switch"><span className="workstation-icon"><Server size={15} /></span><div><strong>本地工作区</strong><small>127.0.0.1</small></div></div>
      <nav aria-label="主导航">
        <div className="nav-label">工作台</div>
        {navigation.filter((item) => item.id !== "settings").map(({ id, name, icon: Icon }) =>
          <a key={id} href={"#" + id} aria-current={pid === id ? "page" : undefined} onClick={() => setMobileNav(false)}>
            <Icon size={18} /><span>{name}</span>{id === "approvals" && !!state?.cards.length && <small className="nav-count">{state.cards.length}</small>}</a>)}
        <div className="nav-group"><div className="nav-label">系统</div><a href="#settings" aria-current={pid === "settings" ? "page" : undefined} onClick={() => setMobileNav(false)}><Settings2 size={18} /><span>运行设置</span></a></div>
      </nav>
      <div className="sidebar-bottom"><span className="workstation-icon"><LockKeyhole size={15} /></span><div><strong>本机连接</strong><small>所有请求经由本地代理</small></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><Button className="icon-button mobile-menu" icon={Menu} aria-label="打开导航" aria-expanded={mobileNav} onClick={() => setMobileNav(!mobileNav)} />
          <span className="breadcrumb-root">工作台</span><ChevronRight size={14} className="breadcrumb-root" /><strong>{route.page.name}</strong></div>
        <div className="top-actions">
          <Badge tone={online ? "green" : online === false ? "red" : "neutral"} dot>{online ? "中台在线" : online === false ? "中台离线" : "检测中"}</Badge>
          <span className="top-divider" />
          <Button className="icon-button" icon={RefreshCw} busy={live.refreshing} aria-label="刷新状态" title="刷新状态" onClick={() => void live.refresh()} />
          <Button className="icon-button" icon={theme === "dark" ? Sun : Moon} aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"} title={theme === "dark" ? "切换浅色主题" : "切换深色主题"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
        </div>
      </header>
      <main className="content" id="main-content">
        {live.error && <ErrorLine>{live.error}{state && ` 当前显示 ${fmtDate(state.now, state.timezone, "full")} 的快照。`}</ErrorLine>}
        {pid === "settings" ? <Settings live={live} /> : state ? <>
          {pid === "overview" && <Dashboard state={state} sendRouter={sendRouter} act={write} />}
          {pid === "runs" && <Runs key={live.generation} state={state} query={route.query} navigate={navigate} />}
          {pid === "rules" && <Rules state={state} name={route.detail} close={() => navigate("#rules")} act={write} choose={setAction}
            disabled={writeDisabled} resumed={resumed} setResumed={(name, pause) => setResumed((previous) => new Map(previous).set(name, pause))} />}
          {pid === "agents" && <Agents state={state} />}
          {pid === "approvals" && <Approvals key={live.generation} state={state} act={write} disabled={writeDisabled} id={detailId} navigate={navigate} />}
          {pid === "events" && <EventFeed facts={live.facts} state={state} connection={live.stream} />}
          {pid === "runs" && detailId && <RunDetail key={detailId} id={detailId} state={state} facts={live.facts} act={write}
            close={() => navigate("#runs" + (route.query.size ? "?" + route.query : ""))} choose={setAction}
            disabled={writeDisabled} />}
        </> : <>
          <Heading title={route.page.name} description="连接本机 Agent Autoloop 中台。" />
          {pid === "overview" && <RouterPanel state={null} send={sendRouter} act={write} />}
          <div className="panel">{live.error ? <Empty title="暂时无法读取中台" icon={Server}><Button icon={RefreshCw} onClick={() => void live.refresh()} busy={live.refreshing}>重新连接</Button></Empty>
            : <Empty title="正在加载中台状态" icon={LoaderCircle}>正在读取当前快照…</Empty>}</div>
        </>}
        {upToDate && <footer className="content-foot"><span>Agent Autoloop</span><span>快照 <code>#{state.seq}</code> <span className="foot-dot">·</span> {state.timezone}</span></footer>}
      </main>
    </div>
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

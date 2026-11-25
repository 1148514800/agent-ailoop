import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder, History, Plus, Search, X } from "lucide-react";
import { routerProjectOf } from "../shared/router.ts";
import type { RouterHistory, RouterProject } from "../shared/router.ts";
import type { State } from "../shared/types.ts";
import { api, messageOf, runLabels, runStatus } from "./data.ts";
import { mergeRuns } from "./model.ts";
import { RouterProjectDialog } from "./router-project-dialog.tsx";
import type { Act } from "./runs.tsx";
import { Button, Confirm, Notice } from "./ui.tsx";

export const historyPath = (id: number) => "/runs/" + id + "/why?view=router";
export const taskTitle = (message: string, fallback: string) => {
  const first = message.trim().split(/\r?\n/, 1)[0].trim();
  const chars = [...first];
  return chars.length > 64 ? chars.slice(0, 64).join("") + "…" : first || fallback;
};

export function useRouterWorkspace(state: State | null, generation: number) {
  const [projects, setProjects] = useState<RouterProject[]>([]);
  const [projectId, setProjectId] = useState(() => localStorage.getItem("autoloop-project") ?? "");
  const [classifierModel, setClassifierModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectError, setProjectError] = useState("");
  const [reload, setReload] = useState(0);
  const [pages, setPages] = useState<State[]>([]);
  const [entries, setEntries] = useState<Record<number, RouterHistory | null>>({});
  const [paging, setPaging] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setProjectError("");
    void api<{ projects: RouterProject[]; classifierModel: string | null }>("/router/projects", { signal: controller.signal })
      .then(({ projects, classifierModel }) => {
        if (controller.signal.aborted) return;
        setProjects(projects);
        setClassifierModel(classifierModel);
        setProjectId((id) => projects.find((item) => item.id === id && !item.error)?.id ??
          projects.find((item) => item.id === "default" && !item.error)?.id ?? projects.find((item) => !item.error)?.id ??
          projects.find((item) => item.id === id)?.id ?? projects[0]?.id ?? "");
      }).catch((error) => {
        if (!controller.signal.aborted) setProjectError(messageOf(error));
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, state?.rulesRevision, generation]);
  const project = projects.find((item) => item.id === projectId);
  useEffect(() => {
    if (!loading && project && !project.error) localStorage.setItem("autoloop-project", project.id);
  }, [loading, project]);
  useEffect(() => { setPages([]); setEntries({}); setHistoryError(""); }, [generation]);

  const runs = mergeRuns(state?.runs ?? [], pages.flatMap((page) => page.runs))
    .filter((run) => !run.manual && routerProjectOf(run.rule, run.events));
  const candidateIds = runs.map((run) => run.id).join(",");
  useEffect(() => {
    if (!candidateIds) return;
    const controller = new AbortController();
    const ids = candidateIds.split(",").map(Number).filter((id) => !Object.hasOwn(entries, id));
    async function read() {
      for (let offset = 0; !controller.signal.aborted && offset < ids.length; offset += 4) {
        const results = await Promise.all(ids.slice(offset, offset + 4).map(async (id) => {
          try { return [id, await api<RouterHistory | null>(historyPath(id), { signal: controller.signal })] as const; }
          catch { return null; }
        }));
        if (controller.signal.aborted) return;
        if (results.includes(null)) setHistoryError("部分历史任务暂时无法读取。");
        setEntries((previous) => ({ ...previous, ...Object.fromEntries(results.filter((row) => row !== null)) }));
      }
    }
    void read();
    return () => controller.abort();
  }, [candidateIds, generation, retry]); // The cached rows only change which IDs the next batch needs.
  const cursor = pages.length ? pages.at(-1)!.nextBefore : state?.nextBefore;
  async function loadOlder() {
    if (!cursor || paging) return;
    setPaging(true); setHistoryError("");
    try { const page = await api<State>("/state?before=" + cursor); setPages((previous) => [...previous, page]); }
    catch (error) { setHistoryError(messageOf(error)); }
    finally { setPaging(false); }
  }

  return {
    projects, project, projectId, setProjectId, classifierModel, loading, projectError,
    reloadProjects: () => { setLoading(true); setReload((value) => value + 1); },
    history: runs.flatMap((run) => {
      const entry = entries[run.id];
      if (!entry) return [];
      return [{ ...entry, run, title: taskTitle(entry.message, "任务 #" + run.id) }];
    }),
    cursor, paging, historyError, loadOlder,
    retryHistory: () => { setHistoryError(""); setRetry((value) => value + 1); },
    notice, setNotice,
  };
}

export type RouterWorkspace = ReturnType<typeof useRouterWorkspace>;

export function ProjectSidebar({ work, active, select, open, add, remove }: {
  work: RouterWorkspace; active: number | null; select(project: RouterProject): void; open(id: number): void;
  add(): void; remove(project: RouterProject): void;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const filter = search?.trim().toLowerCase() ?? "";
  const matching = work.history.filter(({ title, run }) => title.toLowerCase().includes(filter) ||
    String(run.id).includes(filter.replace(/^run\s*#?\s*|^#/, "")));
  const activeScopes = new Set(work.projects.flatMap((project) => project.scope ? [project.scope] : []));
  const archived = new Map<string, typeof matching>();
  for (const entry of matching) {
    if (!activeScopes.has(entry.projectScope)) archived.set(entry.projectScope, [...(archived.get(entry.projectScope) ?? []), entry]);
  }
  const taskLink = ({ run, title }: typeof matching[number]) => {
    const [label, tone] = runLabels[runStatus(run)] ?? runLabels.unknown;
    return <a key={run.id} className="project-task" href={"#router/" + run.id} title={title + " · Run #" + run.id + " · " + label}
      aria-current={active === run.id ? "page" : undefined} onClick={(event) => { event.preventDefault(); open(run.id); }}>
      <span className={"task-dot task-dot-" + tone} aria-label={label} /><span>{title}</span>
    </a>;
  };
  return <>
    <button className="rail-command" type="button" aria-expanded={search !== null} onClick={() => setSearch(search === null ? "" : null)}>
      <Search size={16} /><span>搜索任务</span>
    </button>
    {search !== null && <div className="rail-search"><input aria-label="搜索已加载任务" autoFocus value={search}
      placeholder="标题或 Run ID" onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Escape") setSearch(null);
      }} /></div>}
    <div className="rail-projects">
      <div className="rail-section-label">项目</div>
      <div className="project-scroll">
        {work.projects.map((project) => {
          const children = project.scope ? matching.filter((entry) => entry.projectScope === project.scope) : [];
          if (filter && !children.length) return null;
          const expanded = !!filter || !(collapsed[project.id] ?? project.id !== work.projectId);
          const Icon = expanded ? ChevronDown : ChevronRight;
          return <div key={project.id} className="rail-project">
            <div className="project-row" data-selected={work.projectId === project.id}>
              <button type="button" className="project-toggle" aria-label={(expanded ? "折叠 " : "展开 ") + project.name}
                aria-expanded={expanded} onClick={() => setCollapsed((previous) => ({ ...previous, [project.id]: expanded }))}><Icon size={14} /></button>
              <button type="button" className="project-name" title={project.name} aria-pressed={work.projectId === project.id}
                onClick={() => { select(project); setMenu(null); setCollapsed((previous) => ({ ...previous, [project.id]: false })); }}><Folder size={16} /><span>{project.name}</span></button>
              {project.directory && <button type="button" className="project-menu-button" aria-label={"管理项目 " + project.name} aria-expanded={menu === project.id}
                onClick={() => setMenu(menu === project.id ? null : project.id)}>···</button>}
            </div>
            {menu === project.id && <div className="project-menu">
              <button type="button" onClick={() => { setMenu(null); remove(project); }}>移除项目</button>
            </div>}
            {expanded && (children.length ? children.map(taskLink) : <p className="rail-empty">暂无已加载任务</p>)}
          </div>;
        })}
        {!!archived.size && <details className="archived-projects" open={filter ? true : undefined}>
          <summary><History size={15} /> 历史项目</summary>
          {[...archived].map(([scope, children]) => <div key={scope}><p className="rail-empty" title={children[0].projectId}>{children[0].projectId}</p>{children.map(taskLink)}</div>)}
        </details>}
        {filter && !matching.length && <p className="rail-empty">没有匹配的已加载任务</p>}
        {work.historyError && <div className="rail-empty">{work.historyError} <button type="button" onClick={work.retryHistory}>重试</button></div>}
        {!!work.cursor && <button type="button" className="rail-older" disabled={work.paging} onClick={() => void work.loadOlder()}>{work.paging ? "正在加载…" : "加载更早任务"}</button>}
      </div>
      <button className="rail-command rail-add" type="button" onClick={add}><Plus size={16} /><span>添加项目</span></button>
    </div>
  </>;
}

export function ProjectDialogs({ work, act, adding, removing, close, added }: {
  work: RouterWorkspace; act: Act; adding: boolean; removing: RouterProject | null; close(): void; added(id: string): void;
}) {
  return <>
    {adding && <RouterProjectDialog act={act} close={close} added={(id) => {
      close(); work.reloadProjects(); added(id); work.setNotice("项目已添加。");
    }} />}
    {removing && <Confirm disabled={false} close={close} complete={(message) => {
      close(); work.reloadProjects(); work.setNotice(message);
    }} action={{
      title: "移除项目",
      description: `将「${removing.name}」（${removing.directory}）从 AI Router 的目标项目中移除。工程文件、规则和历史记录会保留。`,
      confirm: "确认移除", danger: true,
      async run() {
        await act("/router/projects/remove", { projectId: removing.id });
        return "项目已从 AI Router 移除。";
      },
    }} />}
  </>;
}

export function WorkspaceNotice({ work }: { work: RouterWorkspace }) {
  if (!work.notice) return null;
  return <div className="workspace-notice"><Notice>{work.notice}
    <Button icon={X} className="icon-button" aria-label="关闭工作台提示" onClick={() => work.setNotice("")} />
  </Notice></div>;
}

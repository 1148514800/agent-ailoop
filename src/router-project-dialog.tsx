import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import type { RouterProjectOptions } from "../shared/router.ts";
import { api, messageOf } from "./data.ts";
import type { Act } from "./runs.tsx";
import { Button, ErrorLine } from "./ui.tsx";

export function RouterProjectDialog({ act, close, added }: { act: Act; close(): void; added(id: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const directoryId = useId();
  const [agents, setAgents] = useState<RouterProjectOptions["agents"] | null>(null);
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const [browseError, setBrowseError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = browsing || saving;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    void api<RouterProjectOptions>("/router/project-options", { signal: controller.signal }).then(({ agents }) => {
      if (!controller.signal.aborted) setAgents(agents);
    }).catch((error) => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => { controller.abort(); element?.close(); };
  }, []);
  async function browse() {
    if (busy) return;
    setBrowsing(true);
    setBrowseError("");
    try {
      const picked = await act<{ directory: string | null }>("/router/projects/pick-folder", {});
      if (picked.directory !== null) setDirectory(picked.directory);
    } catch (error) { setBrowseError(messageOf(error)); }
    finally { setBrowsing(false); }
  }

  return <dialog ref={dialog} className="dialog" aria-labelledby="router-add-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}>
    <div className="dialog-head"><h2 id="router-add-title">添加项目</h2>
      <Button icon={X} className="icon-button" aria-label="关闭" disabled={busy} onClick={close} /></div>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !agents?.length) return;
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      setSaving(true);
      setError("");
      try {
        const { projectId } = await act<{ projectId: string }>("/router/projects", fields);
        added(projectId);
      } catch (error) { setError(messageOf(error)); setSaving(false); }
    }}>
      <label className="field">项目名称<input name="name" maxLength={80} required disabled={saving} /></label>
      <div className="field">
        <label htmlFor={directoryId}>项目目录</label>
        <div className="router-directory-field">
          <input id={directoryId} name="directory" value={directory} onChange={(event) => setDirectory(event.target.value)}
            placeholder="粘贴已有目录的绝对路径" autoComplete="off" required disabled={busy} />
          <Button icon={FolderOpen} busy={browsing} disabled={saving} aria-busy={browsing} onClick={() => void browse()}>浏览文件夹</Button>
        </div>
        {browseError && <ErrorLine>{browseError}</ErrorLine>}
      </div>
      <label className="field">执行 Agent
        <select name="agentId" key={agents === null ? "loading" : "loaded"} defaultValue={agents?.find(({ id }) => id === "codex")?.id ?? agents?.[0]?.id}
          required disabled={saving || !agents?.length}>
          {!agents?.length && <option value="">{agents ? "没有已注册 Agent" : "正在读取 Agent…"}</option>}
          {agents?.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="dialog-actions">
        <Button onClick={close} disabled={busy}>取消</Button>
        <Button type="submit" variant="primary" busy={saving} disabled={browsing || !agents?.length}>保存项目</Button>
      </div>
    </form>
  </dialog>;
}

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { CODEX_EFFORTS } from "../shared/router.ts";
import type { ExecutionConfig, ModelProfile, ProfileChoice, RouterProject } from "../shared/router.ts";
import { api, messageOf } from "./data.ts";
import type { Act } from "./runs.tsx";
import { Button, ErrorLine } from "./ui.tsx";

export const profileLabel: Record<ProfileChoice, string> = { auto: "自动选择", default: "默认配置", fast: "Fast", strong: "Strong" };

export function configValue(config: ExecutionConfig | undefined, field: "model" | "effort") {
  if (config?.use === "dsh" && field === "model" && !config.model) return "使用 DSH 内部默认模型";
  return config?.[field] ?? (config?.use === "codex" ? "继承 Codex CLI 默认" : "未知");
}

export function configSource(config: ExecutionConfig | undefined) {
  if (!config) return "未知";
  if (config.use === "dsh") return config.model ? "执行方案" : "DSH 内部默认";
  if (config.use !== "codex") return config.model || config.effort ? "Autoloop" : "未知";
  if (config.model && config.effort) return "Autoloop";
  if (config.model || config.effort) return "Autoloop / Codex CLI 默认";
  return "Codex CLI 默认";
}

export function ModelDetails({ config }: { config: ExecutionConfig }) {
  return <dl className="router-model-details">
    <div><dt>执行 Agent</dt><dd>{config.name}</dd></div>
    <div><dt>Worker</dt><dd>{config.worker}</dd></div>
    <div><dt>模型配置</dt><dd>{configValue(config, "model")}</dd></div>
    <div><dt>思考强度</dt><dd>{configValue(config, "effort")}</dd></div>
    <div><dt>配置来源</dt><dd>{configSource(config)}</dd></div>
    {config.tier && <div><dt>Codex 服务档位</dt><dd>{config.tier}</dd></div>}
  </dl>;
}

const CUSTOM_MODEL = "!custom";

export function ModelPicker({ initial, models, disabled, defaultLabel = "继承 Codex CLI 默认", catalogLabel = "列表来自本机 Codex 缓存。" }: { initial: string; models: string[] | null; disabled: boolean; defaultLabel?: string; catalogLabel?: string }) {
  const id = useId();
  const [choice, setChoice] = useState(initial);
  const currentOutsideCatalog = choice && choice !== CUSTOM_MODEL && !models?.includes(choice);

  return <>
    <div className="field">
      <label htmlFor={id}>模型 ID</label>
      <select id={id} name={choice === CUSTOM_MODEL ? undefined : "model"} value={choice} disabled={disabled}
        onChange={(event) => setChoice(event.target.value)}>
        <option value="">{defaultLabel}</option>
        {currentOutsideCatalog && <option value={choice}>{choice}（当前配置）</option>}
        {models?.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
        <option value={CUSTOM_MODEL}>自定义模型 ID…</option>
      </select>
    </div>
    {choice === CUSTOM_MODEL && <label className="field">自定义模型 ID
      <input name="model" defaultValue={initial} maxLength={128} autoComplete="off" required disabled={disabled} />
    </label>}
    <p className="muted" aria-live="polite">{models === null ? "正在读取本机 Codex 模型列表…" :
      models.length === 0 ? "可选择自定义模型 ID。" :
      catalogLabel}</p>
  </>;
}

export function ModelProfileDialog({ project, act, close, saved }: {
  project: RouterProject; act: Act; close(): void; saved(profile: ModelProfile): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [profile, setProfile] = useState<ModelProfile>("fast");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const config = project.profiles?.[profile];
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    void api<{ models: string[] }>("/router/model-options", { signal: controller.signal })
      .then(({ models }) => { if (!controller.signal.aborted) setModels(models); })
      .catch(() => { if (!controller.signal.aborted) setModels([]); });
    return () => { controller.abort(); element?.close(); };
  }, []);

  return <dialog ref={dialog} className="dialog" aria-labelledby="model-profile-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}>
    <div className="dialog-head"><h2 id="model-profile-title">模型档位设置</h2>
      <Button icon={X} className="icon-button" aria-label="关闭" disabled={busy} onClick={close} /></div>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      setBusy(true);
      setError("");
      try {
        await act("/router/projects/profile", { ...fields, projectId: project.id, profile });
        saved(profile);
      } catch (error) { setError(messageOf(error)); setBusy(false); }
    }}>
      <p className="muted">{project.name} · {project.execution?.name}</p>
      <label className="field">设置档位
        <select value={profile} disabled={busy} onChange={(event) => { setProfile(event.target.value as ModelProfile); setError(""); }}>
          <option value="fast">Fast{project.profiles?.fast ? "（已配置）" : "（未配置）"}</option>
          <option value="strong">Strong{project.profiles?.strong ? "（已配置）" : "（未配置）"}</option>
        </select>
      </label>
      <ModelPicker key={profile} initial={config?.model ?? ""} models={models} disabled={busy} />
      <label key={profile + "-effort"} className="field">思考强度
        <select name="effort" defaultValue={config?.effort ?? ""} disabled={busy} aria-describedby="model-effort-help">
          <option value="">继承 Codex CLI 默认</option>
          {CODEX_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
      <p id="model-effort-help" className="muted">不同模型支持的思考强度可能不同。</p>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="dialog-actions">
        <Button onClick={close} disabled={busy}>取消</Button>
        <Button type="submit" variant="primary" busy={busy}>保存档位</Button>
      </div>
    </form>
  </dialog>;
}

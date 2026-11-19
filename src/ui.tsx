import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, ArrowUpRight, ChevronDown, CircleCheck, Inbox, LoaderCircle, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export function Button({ children, icon: Icon, variant = "default", busy = false, className = "", ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; variant?: "primary" | "danger" | "default" | "quiet"; busy?: boolean }) {
  return <button type="button" {...props} disabled={props.disabled || busy} className={`button button-${variant} ${className}`}>
    {busy ? <LoaderCircle className="spin" size={16} /> : Icon && <Icon size={16} aria-hidden="true" />}{children}
  </button>;
}

export function Badge({ children, tone = "neutral", dot = false }: { children: ReactNode; tone?: string; dot?: boolean }) {
  return <span className={`badge tone-${tone}`}>{dot && <i aria-hidden="true" />}{children}</span>;
}

export function Heading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{children && <div className="heading-actions">{children}</div>}</div>;
}

export function Panel({ title, icon: Icon, extra, children, className = "", subtitle }: {
  title: string; icon?: LucideIcon; extra?: ReactNode; children: ReactNode; className?: string; subtitle?: string;
}) {
  return <section className={`panel ${className}`}><header className="panel-head">
    <div><h2>{Icon && <Icon size={17} aria-hidden="true" />}{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
    {extra}
  </header>{children}</section>;
}

export function Empty({ title, children, icon: Icon = Inbox }: { title: string; children?: ReactNode; icon?: LucideIcon }) {
  return <div className="empty"><div className="empty-icon"><Icon size={21} /></div><strong>{title}</strong>{children && <div>{children}</div>}</div>;
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return <div className="notice error" role="alert"><AlertCircle size={17} /> <span>{children}</span></div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice success" role="status"><CircleCheck size={17} /> <span>{children}</span></div>;
}

export function Details({ items }: { items: [string, ReactNode][] }) {
  return <dl className="details">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}</dl>;
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return <a className="text-link" href={to}>{children}<ArrowUpRight size={14} aria-hidden="true" /></a>;
}

export function Select({ label, value, onChange, choices }: { label: string; value: string; onChange(value: string): void; choices: [string, string][] }) {
  const id = useId();
  return <div className="select"><label htmlFor={id}>{label}</label><div className="select-field"><select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
    {choices.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
  </select><ChevronDown size={15} aria-hidden="true" /></div></div>;
}

export type Action = {
  title: string; description: string; confirm: string; danger?: boolean;
  fields?: { name: string; label: string; placeholder?: string; value?: string; required?: boolean; max?: number; type?: string }[];
  run(values: Record<string, string>): Promise<string>;
};

export function Confirm({ action, close, complete, disabled }: { action: Action; close(): void; complete(message: string): void; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="dialog" aria-labelledby="confirm-title" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}>
    <div className="dialog-head"><h2 id="confirm-title">{action.title}</h2><Button icon={X} className="icon-button" aria-label="关闭" onClick={close} disabled={busy} /></div>
    <p>{action.description}</p>
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (busy || disabled) return;
      const values = Object.fromEntries([...new FormData(e.currentTarget)].map(([name, value]) => [name, String(value).trim()]));
      setBusy(true); setError("");
      try { complete(await action.run(values)); } catch (error) { setError(error instanceof Error ? error.message : "操作失败，请重试。"); setBusy(false); }
    }}>
      {action.fields?.map((field) => <label className="field" key={field.name}>{field.label}
        <input name={field.name} type={field.type ?? "text"} defaultValue={field.value} placeholder={field.placeholder} maxLength={field.max} required={field.required} disabled={busy} />
      </label>)}
      {error && <ErrorLine>{error}</ErrorLine>}
      {disabled && <p className="muted">中台连接断开，恢复后可以提交。</p>}
      <div className="dialog-actions"><Button onClick={close} disabled={busy}>返回</Button>
        <Button type="submit" variant={action.danger ? "danger" : "primary"} busy={busy} disabled={disabled}>{action.confirm}</Button></div>
    </form>
  </dialog>;
}

export function Drawer({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="drawer" aria-labelledby="drawer-title" onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <section className="drawer-inner">
      <header className="drawer-head"><h2 id="drawer-title">{title}</h2><Button icon={X} className="icon-button" aria-label="关闭详情" onClick={close} /></header>
      <div className="drawer-content">{children}</div>
    </section>
  </dialog>;
}

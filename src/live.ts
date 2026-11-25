import { useEffect, useRef, useState } from "react";
import type { Fact, Health, State } from "../shared/types.ts";
import { api, ApiError, messageOf } from "./data.ts";
import { streamPosition } from "./model.ts";

type StreamState = "connecting" | "live" | "retrying";
type Diagnostic = { message: string; at: number };

export function useLive(onExpired: () => void) {
  const [state, setState] = useState<State | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [stream, setStream] = useState<StreamState>("connecting");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<Diagnostic | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [epoch, setEpoch] = useState(() => new AbortController());
  const currentEpoch = useRef(epoch);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const lifetime = new AbortController();
    let source: EventSource | null = null;
    let cursor: number | null = null;
    let snapshotSeq: number | null = null;
    let hubIdentity: string | undefined;
    let pending: Promise<void> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retry = 1000;
    const { signal } = lifetime;
    let queuedRefresh = false;

    function closeStream() {
      source?.close();
      source = null;
    }

    function reconnect() {
      closeStream();
      if (signal.aborted) return;
      setStream("retrying");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { void refresh().then(connect); }, retry);
      retry = Math.min(retry * 2, 12_000);
    }

    function connect() {
      if (source || cursor === null || signal.aborted) return;
      const opened = new EventSource("/api/stream?after=" + cursor);
      source = opened;
      opened.onopen = () => { if (source === opened) { retry = 1000; setStream("live"); } };
      opened.onerror = () => { if (source === opened) reconnect(); };
      opened.addEventListener("fact", (event: MessageEvent<string>) => {
        if (source !== opened || cursor === null) return;
        let fact: Fact;
        try { fact = JSON.parse(event.data); } catch { reconnect(); return; }
        if (!Number.isSafeInteger(fact.seq) || String(fact.seq) !== event.lastEventId) { reconnect(); return; }
        const position = streamPosition(cursor, fact.seq);
        if (position === "duplicate") return;
        if (position === "gap") { reconnect(); return; }
        cursor = fact.seq;
        setFacts((previous) => [fact, ...previous].slice(0, 200));
        if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 350);
      });
    }

    function refresh(): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      if (pending) {
        queuedRefresh = true;
        const current = pending;
        return current.then(() => pending ?? Promise.resolve());
      }
      pending = (async () => {
        setRefreshing(true);
        const [snapshot, status] = await Promise.allSettled([api<State>("/state", { signal }), api<Health>("/health", { signal })]);
        if (signal.aborted) return;
        setOnline(status.status === "fulfilled" && status.value.ok);
        if (status.status === "fulfilled") setHealth(status.value);
        if (snapshot.status === "rejected") {
          if (snapshot.reason instanceof ApiError && snapshot.reason.status === 401) { onExpired(); return; }
          const message = messageOf(snapshot.reason);
          setError(message);
          setLastError({ message, at: Date.now() });
          return;
        }
        const fresh = snapshot.value;
        const switched = hubIdentity !== undefined && fresh.hubIdentity !== undefined && hubIdentity !== fresh.hubIdentity;
        if (switched || (snapshotSeq !== null && fresh.seq < snapshotSeq)) {
          currentEpoch.current.abort();
          const nextEpoch = new AbortController();
          currentEpoch.current = nextEpoch;
          setEpoch(nextEpoch);
          closeStream();
          clearTimeout(reconnectTimer);
          cursor = fresh.seq;
          setFacts([]);
          setGeneration((previous) => previous + 1);
          setStream("connecting");
        }
        hubIdentity = fresh.hubIdentity;
        snapshotSeq = fresh.seq;
        cursor ??= fresh.seq;
        setState(fresh);
        setError(null);
        if (!source && (retry === 1000 || cursor === fresh.seq)) connect();
      })().finally(() => {
        pending = null;
        if (!signal.aborted && queuedRefresh) {
          queuedRefresh = false;
          void refresh();
        } else if (!signal.aborted) setRefreshing(false);
      });
      return pending;
    }

    refreshRef.current = refresh;
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 20_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      lifetime.abort();
      currentEpoch.current.abort();
      closeStream();
      clearInterval(interval);
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [onExpired]);

  return { state, health, online, stream, facts, error, lastError, refreshing, generation, epoch: epoch.signal, refresh: () => refreshRef.current() };
}

export type Live = ReturnType<typeof useLive>;

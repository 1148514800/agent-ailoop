import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Hub = { url: string; owner: string; secrets: string[]; source?: { name: string; key: string } };

export async function loadHub(): Promise<Hub & { localService: boolean }> {
  const file = join(process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop"), "config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  if (typeof config?.owner !== "string" || !/^[\x21-\x7e]+$/.test(config.owner)) throw new Error("Missing owner");
  const override = process.env.AUTOLOOP_HUB_URL?.trim();
  const options = [override || config.url];
  if (!override && typeof config.hub?.listen === "string") {
    options.push("http://" + config.hub.listen.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:"));
  }
  const url = options.flatMap((value) => {
    try {
      const candidate = new URL(value);
      if (!["http:", "https:"].includes(candidate.protocol) ||
          !["127.0.0.1", "[::1]", "localhost"].includes(candidate.hostname) ||
          candidate.username || candidate.password || candidate.pathname !== "/" || candidate.hash || candidate.search) return [];
      if (candidate.hostname === "localhost") candidate.hostname = "127.0.0.1";
      return [candidate.origin];
    } catch { return []; }
  })[0];
  if (!url) throw new Error("Invalid hub URL");
  const source = typeof config.source?.name === "string" && /^[a-z][a-z0-9-]*$/.test(config.source.name) &&
    typeof config.source.key === "string" && /^[\x21-\x7e]+$/.test(config.source.key)
    ? { name: config.source.name, key: config.source.key } : undefined;
  const keys = [config.worker?.key, config.source?.key, ...Object.values(config.channels ?? {}).map((channel) => (channel as { key?: string } | null)?.key)];
  return {
    url,
    owner: config.owner,
    source,
    secrets: keys.filter((value): value is string => typeof value === "string" && value.length > 0),
    localService: typeof config.hub?.listen === "string",
  };
}

type Row = Record<string, unknown>;
const fields: Record<string, string[]> = {
  runs: ["id", "rule", "agent", "state", "attempts", "not_before", "cancel_at", "session", "created_at", "claimed_at", "finished_at", "summary", "error", "manual", "rules_version"],
  events: ["id", "source", "key", "type", "subject", "summary", "detail", "received_at", "routed", "paused"],
  cards: ["id", "title", "kind", "state", "rule", "run_id", "answer_event", "answer", "options", "choice", "result", "by", "created_at", "decided_at", "closed_at"],
  run_events: ["run_id", "event_id"],
  timers: ["rule", "key", "about", "at"],
  pauses: ["name", "since", "until", "reason"],
  schedules: ["rule", "next_at", "skipped_at"],
  deliveries: ["card_id", "channel", "error"],
  seen: ["kind", "name", "seen_at"],
};

export function safeFact(fact: Row) {
  if (!Number.isSafeInteger(fact?.seq) || !Array.isArray(fact.changes)) throw new Error("Invalid fact");
  const changes = (fact.changes as { table: string; key: string; row: Row | null }[]).flatMap(({ table, key, row }) => {
    if (table === "config" && key === "rules") return [{ table, key, row: null }];
    if (!Object.hasOwn(fields, table)) return [];
    return [{ table, key, row: row ? Object.fromEntries(fields[table].filter((name) => Object.hasOwn(row, name)).map((name) => [name, row[name]])) : null }];
  });
  return { seq: fact.seq, at: fact.at, type: fact.type, changes };
}

export function redact(value: unknown, hub: Hub): string {
  const secrets = [hub.owner, ...hub.secrets].sort((a, b) => b.length - a.length);
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    return secrets.reduce((result, secret) => result.replaceAll(secret, "[已隐藏]"), item);
  });
}

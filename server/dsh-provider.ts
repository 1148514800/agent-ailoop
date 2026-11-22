import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DSH_APIS, DSH_EFFORTS, type DshProvider } from "../shared/router.ts";
import type { ImportedDshModel } from "./dsh-import-schema.ts";
import { dataHome } from "./router-rule-config.ts";
import { RouterError } from "./router.ts";

const keyName = "AUTOLOOP_DSH_API_KEY";
const store = () => resolve(dataHome(), "dsh-routes");
const refPattern = /^[a-f0-9]{32}$/;
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const keyPattern = /^[\x21-\x7e]{1,2048}$/;

export function baseAddress(input: string) {
  try {
    const url = new URL(input);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new RouterError(400, "Base URL 必须是 HTTPS 地址。本机回环地址也可使用 HTTP。请勿附带凭据、查询参数或锚点。");
  }
}

export async function prepareDshProvider(
  value: unknown, model: string, effort: string, previous?: { provider: DshProvider; model: string; effort: string }, imported?: ImportedDshModel,
) {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 5 || !model) {
    throw new RouterError(400, "请填写 DSH 自定义供应商和模型 ID。");
  }
  const { api, baseURL, key, thinkingFormat, effortValue } = value as Record<string, unknown>;
  const protocol = DSH_APIS.find((item) => item === api);
  if (!protocol || typeof baseURL !== "string" || baseURL.length > 2048 || typeof key !== "string" ||
      (key && !keyPattern.test(key)) || (thinkingFormat !== "default" && thinkingFormat !== "deepseek") ||
      (thinkingFormat === "deepseek" && protocol !== "openai-completions") ||
      (effort && !DSH_EFFORTS.some((item) => item === effort)) ||
      typeof effortValue !== "string" || (effortValue && (!effort || !/^[\w.-]{1,32}$/.test(effortValue)))) {
    throw new RouterError(400, "请核对 DSH 的 API 协议、推理选项和 API Key。");
  }
  const address = baseAddress(baseURL.trim());
  const details = { api: protocol, baseURL: imported ? baseURL : address, thinkingFormat, effortValue } satisfies Omit<DshProvider, "ref">;
  const prior = previous?.provider;
  const sameGateway = prior && prior.api === details.api && prior.baseURL === details.baseURL;
  const saved = sameGateway && refPattern.test(prior.ref)
    ? await readFile(join(store(), prior.ref, ".credentials.yaml"), "utf8").then((raw) => {
      const secret = JSON.parse(raw)?.refs?.[keyName];
      return typeof secret === "string" && keyPattern.test(secret) ? secret : undefined;
    }).catch(() => undefined) : undefined;
  if (!key && !sameGateway) throw new RouterError(400, "新增或更换供应商地址或协议时，请重新填写 API Key。");
  const secret = key || saved;
  if (!secret) throw new RouterError(409, "未找到这个 DSH 供应商的本机 API Key，请重新填写。");
  if (secret.length >= 8 && [details.baseURL, model, effortValue, JSON.stringify(imported) ?? ""].some((field) => field.includes(secret))) {
    throw new RouterError(400, "供应商地址、模型和推理强度字段不能包含 API Key。");
  }
  if (saved === secret && sameGateway && previous.model === model && previous.effort === effort &&
      prior.thinkingFormat === thinkingFormat && prior.effortValue === effortValue && !!prior.source === !!imported) {
    const snapshot = await readFile(join(store(), prior.ref, "route.yml"), "utf8").catch(() => undefined);
    if (snapshot === providerPatch(prior, model, effort, imported)) return { provider: prior, secret };
  }
  return { provider: { ref: randomUUID().replaceAll("-", ""), ...details }, secret, imported, create: true as const };
}

function providerPatch(provider: DshProvider, model: string, effort: string, imported?: ImportedDshModel) {
  // DSH requires at least one enabled level even when the selected level is off.
  const reasoningEfforts = effort === "off" ? { off: provider.effortValue || null, high: "high" }
    : effort ? { [effort]: provider.effortValue || effort } : undefined;
  const configuration = imported?.provider ?? (effort ? { reasoning: effort } : {});
  const fields = imported?.model ?? {
    reasoningEfforts, ...(provider.thinkingFormat === "deepseek" && { compat: { thinkingFormat: "deepseek" } }),
  };
  const route = {
    api: provider.api, apiKeyEnv: keyName, baseURL: provider.baseURL, ...configuration, models: [{ id: model, ...fields }],
  };
  const id = imported?.id ?? "autoloop-gateway";
  return json([
    { id: "credentials", name: "@deepseek-ai/dsh-credentials-local", disabled: false,
      config: { path: join(store(), provider.ref, ".credentials.yaml") } },
    { id: "llm-pi-ai", config: { providers: { [id]: route } } },
    { id: "agent-default-model", config: { provider: id, model, ...(effort && { reasoningEffort: effort }) } },
  ]);
}

export async function writeDshProvider(provider: DshProvider, secret: string, model: string, effort: string, imported?: ImportedDshModel) {
  const directory = join(store(), provider.ref);
  await mkdir(store(), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  try {
    const credentials = join(directory, ".credentials.yaml");
    await writeFile(credentials, json({ version: 1, refs: { [keyName]: secret } }), { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "route.yml"), providerPatch(provider, model, effort, imported), { flag: "wx", mode: 0o600 });
  } catch {
    await removeUnpublishedDshProvider(provider);
    throw new RouterError(503, "无法保存本机 DSH 供应商配置。");
  }
}

export async function removeUnpublishedDshProvider(provider: DshProvider) {
  await rm(join(store(), provider.ref), { recursive: true, force: true }).catch(() => {});
}

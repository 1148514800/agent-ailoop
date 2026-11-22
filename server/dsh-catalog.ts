import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parse } from "yaml";
import { DSH_APIS, DSH_EFFORTS, type DshCatalogEntry } from "../shared/router.ts";
import { compatibilityError, modelOptions, object, providerOptions } from "./dsh-import-schema.ts";
import { baseAddress } from "./dsh-provider.ts";
import { RouterError } from "./router.ts";

const profileName = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  Buffer.byteLength(value) <= 255 && !/[<>:"/\\|?*\u0000-\u001f\u007f]|[. ]$/.test(value) &&
  !/^(?:node_modules$|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))/i.test(value);
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const providerId = /^[a-z][a-z0-9-]{0,63}$/;
const credentialRef = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const dshHome = () => realpath(resolve(process.env.DSH_HOME || join(homedir(), ".dsh"))).catch(() => undefined);

async function readYaml(file: string): Promise<unknown> {
  const limit = 1024 * 1024;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > limit || await realpath(file) !== file) return undefined;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino || await realpath(file) !== file) return undefined;
      const data = Buffer.alloc(Math.min(actual.size + 1, limit + 1));
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead !== actual.size || bytesRead > limit) return undefined;
      return parse(data.toString("utf8", 0, bytesRead), { maxAliasCount: 0, logLevel: "silent", uniqueKeys: true });
    } finally { await handle.close(); }
  } catch { return undefined; }
}

async function directoryProfiles(home: string) {
  const directory = join(home, "profiles");
  if (await realpath(directory).catch(() => undefined) !== directory) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && profileName(entry.name)).map((entry) => entry.name).sort();
}

async function profileRoutes(home: string, profile: string) {
  const tree = await readYaml(join(home, "profiles", profile, "cordis.patch.yml"));
  if (!Array.isArray(tree)) return [];
  const entries = tree.map(object);
  const provider = entries.findLast((entry) => entry.id === "llm-pi-ai");
  if (!provider) return [];
  const credentials = entries.findLast((entry) => entry.id === "credentials");
  const selection = entries.findLast((entry) => entry.id === "agent-default-model");
  const selected = selection?.disabled ? {} : object(selection?.config);
  return Object.entries(object(object(provider.config).providers)).flatMap(([id, setting]) => {
    if (!providerId.test(id)) return [];
    const route = object(setting);
    const api = DSH_APIS.find((value) => value === route.api);
    const baseURL = typeof route.baseURL === "string" && route.baseURL.length <= 2048 ? route.baseURL : "";
    const credential = typeof route.apiKeyEnv === "string" && credentialRef.test(route.apiKeyEnv) ? route.apiKeyEnv : "";
    let reason: string | undefined;
    let options: Record<string, unknown> = {};
    if (provider.disabled) reason = "DSH Profile 已停用此供应商插件。";
    else if (credentials && (credentials.disabled || Object.keys(object(credentials.config)).length ||
        (credentials.name && credentials.name !== "@deepseek-ai/dsh-credentials-local"))) {
      reason = "此 Profile 使用非默认凭据存储，无法安全复用。";
    } else if (provider.name && provider.name !== "@deepseek-ai/dsh-llm-pi-ai") reason = "此 Profile 使用自定义供应商插件。";
    else if (!api) reason = "当前 API 协议不支持导入。";
    else {
      try {
        baseAddress(baseURL);
        if (!credential) reason = "缺少受支持的 API Key 引用。";
        else options = providerOptions(route, api);
      } catch (error) {
        reason = error instanceof RouterError ? "供应商地址无效或附带了凭据、查询参数或锚点。" : compatibilityError(error);
      }
    }

    const configured = Array.isArray(route.models) ? route.models.map(object) : [];
    const models = configured.flatMap((model) => {
      if (typeof model.id !== "string" || !modelId.test(model.id)) return [];
      const selectedModel = model.id;
      let modelReason = configured.filter((item) => item.id === selectedModel).length > 1 ? "模型 ID 重复。" : undefined;
      let fields: Record<string, unknown> = {};
      if (!modelReason && api && !reason) {
        try { fields = modelOptions(model, api); }
        catch (error) { modelReason = compatibilityError(error); }
      }
      const reasoning = object(fields.reasoningEfforts);
      const efforts = DSH_EFFORTS.filter((effort) => Object.hasOwn(reasoning, effort));
      const defaultEffort = selected.provider === id && selected.model === selectedModel && selected.reasoningEffort !== undefined
        ? selected.reasoningEffort : options.reasoning;
      return [{ id: selectedModel, fields, efforts, defaultEffort, reason: modelReason }];
    });
    return [{ profile, id, api, baseURL, credential, options, models, reason: reason ?? (!models.length ? "供应商没有显式声明可导入的模型。" : undefined) }];
  });
}

async function portableRoutes(home: string) {
  return (await Promise.all((await directoryProfiles(home)).map((profile) => profileRoutes(home, profile)))).flat();
}

export async function dshCatalog(): Promise<DshCatalogEntry[]> {
  const home = await dshHome();
  if (!home) return [];
  return (await portableRoutes(home)).map(({ profile, id, api, models, reason }) => ({
    profile, id, api, reason, models: models.map(({ id, efforts, reason }) => ({ id, efforts, reason })),
  }));
}

export async function configuredDshRoute(input: unknown, modelId: string, effort: string) {
  const { profile, id } = object(input);
  const home = await dshHome();
  if (!home || !profileName(profile) || typeof id !== "string" || !providerId.test(id)) {
    throw new RouterError(400, "DSH Profile 或供应商标识无效。");
  }
  const route = (await portableRoutes(home)).find((item) => item.profile === profile && item.id === id);
  if (!route) throw new RouterError(409, "原 DSH 供应商配置已失效或不可安全读取。");
  if (route.reason || !route.api) throw new RouterError(409, route.reason ?? "该供应商无法导入。");
  const model = route.models.find((item) => item.id === modelId);
  if (model?.reason) throw new RouterError(409, model.reason);
  if (!model || (effort && !model.efforts.some((level) => level === effort))) {
    throw new RouterError(400, "请选择 DSH 本机配置中支持的模型和推理级别。");
  }
  const credentials = object(await readYaml(join(home, ".credentials.yaml")));
  const key = (credentials.version === 1 ? object(credentials.refs)[route.credential] : undefined) || process.env[route.credential];
  if (typeof key !== "string" || !key) throw new RouterError(409, "未找到该 DSH 供应商的本机凭据，可使用自定义供应商配置。");
  const compat = { ...object(route.options.compat), ...object(model.fields.compat) };
  const defaultEffort = model.efforts.find((level) => level === model.defaultEffort);
  return {
    settings: { api: route.api, baseURL: route.baseURL, key,
      thinkingFormat: compat.thinkingFormat === "deepseek" ? "deepseek" : "default", effortValue: "" },
    source: { profile: route.profile, id: route.id },
    imported: { id: route.id, provider: { ...route.options, ...(defaultEffort && { reasoning: defaultEffort }) }, model: model.fields },
  };
}

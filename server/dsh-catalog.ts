import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parse } from "yaml";
import { DSH_APIS, DSH_EFFORTS, type DshCatalogEntry } from "../shared/router.ts";
import { RouterError } from "./router.ts";

const profiles = ["headless", "desktop"] as const;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const dshHome = () => resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function readYaml(file: string): Promise<unknown> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    return parse(await readFile(file, "utf8"), { maxAliasCount: 0, logLevel: "silent", uniqueKeys: true });
  } catch { return undefined; }
}

async function portableRoutes() {
  const found = await Promise.all(profiles.map(async (profile) => {
    const tree = await readYaml(join(dshHome(), "profiles", profile, "cordis.patch.yml"));
    if (!Array.isArray(tree)) return [];
    const provider = tree.map(object).findLast((entry) => entry.id === "llm-pi-ai");
    if (!provider || provider.disabled) return [];
    return Object.entries(object(object(provider.config).providers)).flatMap(([id, setting]) => {
      const route = object(setting);
      const api = DSH_APIS.find((value) => value === route.api);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !api || typeof route.baseURL !== "string" ||
          typeof route.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(route.apiKeyEnv) ||
          !Array.isArray(route.models)) return [];
      const models = route.models.map(object).flatMap((model) => {
        if (typeof model.id !== "string" || !modelId.test(model.id)) return [];
        const reasoning = object(model.reasoningEfforts);
        const efforts = DSH_EFFORTS.filter((effort) => typeof reasoning[effort] === "string" && /^[\w.-]{1,32}$/.test(reasoning[effort]) ||
          effort === "off" && Object.hasOwn(reasoning, effort) && reasoning[effort] === null);
        return [{ id: model.id, efforts, reasoning, compat: { ...object(route.compat), ...object(model.compat) } }];
      });
      return models.length ? [{ profile, id, api, baseURL: route.baseURL, credential: route.apiKeyEnv, models }] : [];
    });
  }));
  return found.flat();
}

export async function dshCatalog(): Promise<DshCatalogEntry[]> {
  return (await portableRoutes()).map(({ profile, id, api, models }) => ({
    profile, id, api, models: models.map(({ id, efforts }) => ({ id, efforts })),
  }));
}

export async function configuredDshRoute(input: unknown, modelId: string, effort: string) {
  const { profile, id } = object(input);
  const route = (await portableRoutes()).find((item) => item.profile === profile && item.id === id);
  const model = route?.models.find((item) => item.id === modelId);
  if (!route || !model || (effort && !model.efforts.some((level) => level === effort))) {
    throw new RouterError(400, "请选择 DSH 本机配置中支持的供应商、模型和推理级别。");
  }
  const credentials = object(await readYaml(join(dshHome(), ".credentials.yaml")));
  const key = (credentials.version === 1 ? object(credentials.refs)[route.credential] : undefined) || process.env[route.credential];
  if (typeof key !== "string" || !key) throw new RouterError(409, "未找到该 DSH 供应商的本机凭据，可使用自定义供应商配置。");
  return {
    settings: { api: route.api, baseURL: route.baseURL, key,
      thinkingFormat: model.compat.thinkingFormat === "deepseek" ? "deepseek" : "default",
      effortValue: effort && typeof model.reasoning[effort] === "string" ? model.reasoning[effort] : "" },
    source: { profile: route.profile, id: route.id },
  };
}

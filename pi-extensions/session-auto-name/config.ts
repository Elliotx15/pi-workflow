import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelConfig {
  provider: string;
  modelId: string;
}

export const CONFIG_FILE = "session-auto-name.json";

/** Read the highest-priority complete model selection; never merge model identities. */
export function loadConfig(agentDir: string, cwd: string, projectTrusted: boolean): ModelConfig | undefined {
  const paths = [join(agentDir, CONFIG_FILE)];
  if (projectTrusted) paths.unshift(join(cwd, ".pi", CONFIG_FILE));

  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`无法读取配置：${path}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`配置不是有效 JSON：${path}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`配置必须是 JSON 对象：${path}`);
    }
    const config = value as Record<string, unknown>;
    const keys = Object.keys(config);
    if (keys.length === 0) continue;
    if (
      keys.some((key) => key !== "provider" && key !== "modelId") ||
      typeof config.provider !== "string" || !config.provider.trim() ||
      typeof config.modelId !== "string" || !config.modelId.trim()
    ) {
      throw new Error(`配置仅支持成对填写非空 provider 和 modelId：${path}`);
    }
    return { provider: config.provider.trim(), modelId: config.modelId.trim() };
  }
  return undefined;
}

export function resolveModel(
  config: ModelConfig | undefined,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): Model<Api> {
  if (!config) {
    if (!ctx.model) throw new Error("当前 session 尚未选择模型");
    return ctx.model;
  }
  const model = ctx.modelRegistry.find(config.provider, config.modelId);
  if (!model) throw new Error(`未找到命名模型：${config.provider}/${config.modelId}`);
  return model;
}

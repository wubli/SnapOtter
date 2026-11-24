import { PYTHON_SIDECAR_TOOLS } from "@snapotter/shared";
import { env } from "../config.js";

const OPENAI_AUDIO_TOOLS = new Set(["transcribe-audio", "auto-subtitles"]);
const NATIVE_TOOLS = new Set(["smart-crop", "ocr", "ocr-pdf"]);
const LOCAL_ONLY_TOOLS = PYTHON_SIDECAR_TOOLS.filter(
  (id) => !OPENAI_AUDIO_TOOLS.has(id) && !NATIVE_TOOLS.has(id),
);

export function resolveDeploymentDisabledTools(
  provider: "local" | "openai",
  hasOpenAiKey: boolean,
): string[] {
  if (provider !== "openai") return [];
  return hasOpenAiKey ? [...LOCAL_ONLY_TOOLS] : [...LOCAL_ONLY_TOOLS, ...OPENAI_AUDIO_TOOLS];
}

export const deploymentDisabledTools = resolveDeploymentDisabledTools(
  env.AI_PROVIDER,
  Boolean(env.OPENAI_API_KEY?.trim()),
);

const deploymentDisabledSet = new Set(deploymentDisabledTools);

export function isDeploymentToolDisabled(toolId: string): boolean {
  return deploymentDisabledSet.has(toolId);
}

export function isOpenAiTool(toolId: string): boolean {
  return (
    env.AI_PROVIDER === "openai" &&
    OPENAI_AUDIO_TOOLS.has(toolId) &&
    !isDeploymentToolDisabled(toolId)
  );
}

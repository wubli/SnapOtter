import { PYTHON_SIDECAR_TOOLS } from "@snapotter/shared";
import { describe, expect, it } from "vitest";
import { resolveDeploymentDisabledTools } from "../../../apps/api/src/lib/ai-tool-policy.js";

describe("AI deployment tool policy", () => {
  it("keeps the local tool catalog even when an OpenAI key is supplied", () => {
    expect(resolveDeploymentDisabledTools("local", true)).toEqual([]);
    expect(resolveDeploymentDisabledTools("local", false)).toEqual([]);
  });

  it("keeps native conversions and enables the supported speech tools with a key", () => {
    const disabledTools = resolveDeploymentDisabledTools("openai", true);
    const remoteOrNativeTools = [
      "transcribe-audio",
      "auto-subtitles",
      "smart-crop",
      "ocr",
      "ocr-pdf",
    ];
    expect(disabledTools).toEqual(
      PYTHON_SIDECAR_TOOLS.filter((id) => !remoteOrNativeTools.includes(id)),
    );
    for (const toolId of [
      "content-aware-resize",
      "image-enhancement",
      "convert",
      "convert-audio",
    ]) {
      expect(disabledTools).not.toContain(toolId);
    }
  });

  it("also disables speech tools without a key", () => {
    expect(resolveDeploymentDisabledTools("openai", false)).toContain("transcribe-audio");
    expect(resolveDeploymentDisabledTools("openai", false)).toContain("auto-subtitles");
  });
});

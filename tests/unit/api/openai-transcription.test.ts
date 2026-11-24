import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  probeMedia: vi.fn(async () => ({ streams: [{ type: "audio" }] })),
  runFfmpeg: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock("@snapotter/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@snapotter/ai")>()),
  transcribeAudio: mocks.transcribeAudio,
}));

vi.mock("@snapotter/media-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@snapotter/media-engine")>()),
  probeMedia: mocks.probeMedia,
  runFfmpeg: mocks.runFfmpeg,
}));

import { runAiToolJob } from "../../../apps/api/src/jobs/ai-handlers.js";
import type { ToolJobData } from "../../../apps/api/src/jobs/types.js";
import { NO_SPEECH_DETECTED_WARNING } from "../../../apps/api/src/lib/empty-result-warnings.js";
import "../../../apps/api/src/routes/tools/auto-subtitles.js";
import "../../../apps/api/src/routes/tools/transcribe-audio.js";

let scratchDir: string;
let controller: AbortController;
const input = Buffer.from("media");
let audioFixtures: Buffer[];

function makePcm(durationS: number, audible: [number, number][], level = 4096): Buffer {
  const pcm = Buffer.alloc(Math.round(durationS * 16_000) * 2);
  const sample = Buffer.alloc(2);
  sample.writeInt16LE(level);
  for (const [start, end] of audible) {
    pcm.fill(sample, start * 32_000, end * 32_000);
  }
  return pcm;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "test-only-key");
  vi.stubGlobal("fetch", mocks.fetch);
  scratchDir = await mkdtemp(join(tmpdir(), "snapotter-transcription-"));
  controller = new AbortController();
  audioFixtures = [makePcm(600.02, [[0.4, 1.26]]), makePcm(0.98, [[0.2, 0.7]])];
  mocks.probeMedia.mockResolvedValue({ streams: [{ type: "audio" }] });
  mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
    const list = args[args.indexOf("-segment_list") + 1];
    const extension = args.includes("s16le") ? "pcm" : "wav";
    await writeFile(
      list,
      `chunk-000000.${extension},0.000000,600.020000\nchunk-000001.${extension},600.020000,601.000000\n`,
    );
    await writeFile(
      join(dirname(list), `chunk-000000.${extension}`),
      extension === "pcm" ? audioFixtures[0] : "chunk one",
    );
    await writeFile(
      join(dirname(list), `chunk-000001.${extension}`),
      extension === "pcm" ? audioFixtures[1] : "chunk two",
    );
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(scratchDir, { recursive: true, force: true });
});

function run(toolId: string, settings: Record<string, unknown>) {
  const filename = toolId === "auto-subtitles" ? "clip.mp4" : "speech.wav";
  const data: ToolJobData = {
    jobId: "transcribe-job",
    toolId,
    filename,
    userId: null,
    pool: "ai",
    inputRefs: [`uploads/transcribe-job/${filename}`],
    settings,
    kind: "ai-tool",
  };
  return runAiToolJob(data, input, { scratchDir, signal: controller.signal, report: vi.fn() });
}

describe("OpenAI transcription job processing", () => {
  it("sends only generated audio chunks and assembles a plain-text transcript", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ text: "Hello.", languages: [{ code: "en" }] }),
    );
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ text: "Goodbye.", languages: [{ code: "en" }] }),
    );

    const result = await run("transcribe-audio", { provider: "openai", outputFormat: "txt" });

    expect(result).toMatchObject({
      filename: "speech.txt",
      contentType: "text/plain",
      resultPayload: { language: "en", segments: 0 },
    });
    expect(result.buffer.toString("utf8")).toBe("Hello.\nGoodbye.");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-only-key" });
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("languages[]")).toBeNull();
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("Expected an audio upload");
    expect(file.name).toBe("chunk-000000.wav");
    expect(await file.text()).toBe("chunk one");
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });

  it("sends the language hint in the plain-text model's multipart array field", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ text: "Bonjour." }));
    const result = await run("transcribe-audio", { provider: "openai", language: "fr" });

    const form = mocks.fetch.mock.calls[0][1]?.body as FormData;
    expect(form.getAll("languages[]")).toEqual(["fr"]);
    expect(form.get("language")).toBeNull();
    expect(result.resultPayload?.language).toBe("fr");
  });

  it.each([
    ["transcribe-audio", { outputFormat: "srt" }, "00:10:00,160 --> 00:10:00,780"],
    ["auto-subtitles", { format: "vtt" }, "00:10:00.160 --> 00:10:00.780"],
  ])(
    "writes audio-anchored cue timestamps for %s across chunk boundaries",
    async (toolId, settings, cue) => {
      mocks.fetch.mockResolvedValueOnce(
        Response.json({
          text: "Hello.",
        }),
      );
      mocks.fetch.mockResolvedValueOnce(
        Response.json({
          text: "Goodbye.",
        }),
      );

      const result = await run(toolId, { provider: "openai", language: "en", ...settings });

      expect(result.buffer.toString("utf8")).toContain(`${cue}\nGoodbye.`);
      expect(result.resultPayload).toEqual({ language: "en", segments: 2 });
      const form = mocks.fetch.mock.calls[0][1]?.body as FormData;
      expect(form.get("model")).toBe("gpt-transcribe");
      expect(form.get("response_format")).toBe("json");
      expect(form.get("timestamp_granularities[]")).toBeNull();
      expect(form.get("languages[]")).toBe("en");
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("Expected an audio upload");
      expect(file.type).toBe("audio/wav");
      const wave = Buffer.from(await file.arrayBuffer());
      expect(wave.subarray(0, 12).toString("ascii")).toMatch(/^RIFF.{4}WAVE$/s);
      expect(wave.readUInt32LE(24)).toBe(16_000);
      expect(wave.readUInt32LE(40)).toBe((1.32 - 0.34) * 32_000);
    },
  );

  it("returns an empty subtitle artifact without uploading silent media", async () => {
    audioFixtures = [makePcm(0.5, []), makePcm(0.98, [])];
    const result = await run("auto-subtitles", { provider: "openai", format: "vtt" });
    expect(result.buffer.toString("utf8")).toBe("WEBVTT\n\n");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(result.resultPayload).toMatchObject({
      segments: 0,
      warning: NO_SPEECH_DETECTED_WARNING,
    });
  });

  it("reports an upstream failure without including the response body", async () => {
    mocks.fetch.mockResolvedValue(new Response("secret details", { status: 429 }));
    await expect(run("transcribe-audio", { provider: "openai" })).rejects.toThrow(
      /^OpenAI transcription failed \(HTTP 429\)$/,
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("skips blank transcripts and splits long cues at nearby low-energy frames", async () => {
    audioFixtures = [
      makePcm(14, [
        [0.4, 1.26],
        [1.9, 7.71],
        [7.81, 13.4],
      ]),
      makePcm(0.98, []),
    ];
    mocks.fetch.mockResolvedValueOnce(Response.json({ text: " " }));
    mocks.fetch.mockResolvedValueOnce(Response.json({ text: "First\n\npart." }));
    mocks.fetch.mockResolvedValueOnce(Response.json({ text: "Second part." }));

    const result = await run("auto-subtitles", { provider: "openai", format: "vtt" });

    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(result.buffer.toString("utf8")).toBe(
      "WEBVTT\n\n00:00:01.840 --> 00:00:07.740\nFirst part.\n\n00:00:07.740 --> 00:00:13.460\nSecond part.\n",
    );
    expect(result.resultPayload).toMatchObject({ segments: 2 });
  });

  it("picks up a low-level signal when it stands above the background", async () => {
    audioFixtures = [makePcm(1.5, [[0.4, 1.2]], 55), makePcm(0.98, [])];
    mocks.fetch.mockResolvedValueOnce(Response.json({ text: "Quiet speech." }));

    const result = await run("auto-subtitles", { provider: "openai", format: "srt" });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(result.buffer.toString("utf8")).toContain(
      "00:00:00,340 --> 00:00:01,260\nQuiet speech.",
    );
  });

  it("aborts an in-flight upload and does not send the next chunk", async () => {
    mocks.fetch.mockImplementation(async (_url, init) => {
      controller.abort(new Error("Canceled"));
      init?.signal?.throwIfAborted();
      return Response.json({ text: "unexpected" });
    });

    await expect(run("transcribe-audio", { provider: "openai" })).rejects.toThrow("Canceled");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a previously queued local job local", async () => {
    mocks.runFfmpeg.mockResolvedValue(undefined);
    mocks.transcribeAudio.mockResolvedValue({ text: "local", language: "en", segments: [] });

    const result = await run("transcribe-audio", { outputFormat: "txt" });

    expect(result.buffer.toString("utf8")).toBe("local");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

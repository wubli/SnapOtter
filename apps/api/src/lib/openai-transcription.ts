import { openAsBlob } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptionResult } from "@snapotter/ai";
import { runFfmpeg } from "@snapotter/media-engine";
import { z } from "zod";
import type { ToolProcessCtx } from "../routes/tool-factory.js";

const endpoint = "https://api.openai.com/v1/audio/transcriptions";
const uploadLimitBytes = 25_000_000;
const requestTimeoutMs = 5 * 60_000;
const chunkDurationS = 600;

const responseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  languages: z.array(z.object({ code: z.string() })).optional(),
  segments: z
    .array(
      z
        .object({
          start: z.number().finite().nonnegative(),
          end: z.number().finite(),
          text: z.string(),
        })
        .refine(({ start, end }) => end >= start),
    )
    .optional(),
});

async function transcribeChunk(
  file: Blob,
  filename: string,
  language: string,
  timed: boolean,
  apiKey: string,
  jobSignal: AbortSignal,
) {
  const form = new FormData();
  form.set("file", file, filename);
  // Whisper supplies segment timestamps for SRT/VTT. OpenAI has announced
  // its shutdown for February 26, 2027.
  form.set("model", timed ? "whisper-1" : "gpt-transcribe");
  form.set("response_format", timed ? "verbose_json" : "json");
  if (timed) form.set("timestamp_granularities[]", "segment");
  if (language !== "auto") form.set(timed ? "language" : "languages[]", language);

  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = AbortSignal.any([jobSignal, timeout]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
      redirect: "error",
    });
  } catch {
    jobSignal.throwIfAborted();
    throw new Error(
      timeout.aborted ? "OpenAI transcription timed out" : "Could not reach OpenAI transcription",
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenAI transcription failed (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    jobSignal.throwIfAborted();
    throw new Error(
      timeout.aborted
        ? "OpenAI transcription timed out"
        : "OpenAI returned an invalid transcription response",
    );
  }
  const result = responseSchema.safeParse(body);
  if (!result.success || (timed && result.data.text.trim() && !result.data.segments?.length)) {
    throw new Error("OpenAI returned an invalid transcription response");
  }
  return result.data;
}

export async function transcribeWithOpenAi(
  inputPath: string,
  { language, timed, startProgress }: { language: string; timed: boolean; startProgress: number },
  ctx: ToolProcessCtx,
): Promise<TranscriptionResult> {
  if (process.env.AI_PROVIDER !== "openai") {
    throw new Error("OpenAI transcription is disabled");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI transcription is missing its API key");
  ctx.signal.throwIfAborted();

  const chunkDir = join(ctx.scratchDir, "openai-audio");
  await mkdir(chunkDir, { recursive: true });
  const chunkList = join(chunkDir, "chunks.csv");
  // Ten minutes of 16 kHz mono PCM consumes roughly 19 MB. The segment list
  // records the exact split points, which can differ from the requested times.
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-af",
      "aresample=16000:async=1:first_pts=0",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "segment",
      "-segment_time",
      String(chunkDurationS),
      "-reset_timestamps",
      "1",
      "-segment_list",
      chunkList,
      join(chunkDir, "chunk-%06d.wav"),
    ],
    { timeoutMs: 10 * 60_000, signal: ctx.signal },
  );
  const rows = (await readFile(chunkList, "utf8")).trim().split("\n");
  const segments: TranscriptionResult["segments"] = [];
  const transcripts: string[] = [];
  let detectedLanguage = language === "auto" ? "" : language;
  ctx.report(startProgress, "Transcribing audio");

  for (const [index, row] of rows.entries()) {
    ctx.signal.throwIfAborted();
    const [filename, start, end] = row.trim().split(",");
    const offset = Number(start);
    const duration = Number(end) - offset;
    if (
      !/^chunk-\d{6}\.wav$/.test(filename) ||
      !start ||
      !end ||
      !Number.isFinite(offset) ||
      !Number.isFinite(duration) ||
      offset < 0 ||
      duration <= 0
    ) {
      throw new Error("Could not prepare audio for OpenAI transcription");
    }
    const file = await openAsBlob(join(chunkDir, filename), { type: "audio/wav" });
    if (file.size > uploadLimitBytes) {
      throw new Error("Prepared audio exceeds the OpenAI transcription upload limit");
    }
    const result = await transcribeChunk(file, filename, language, timed, apiKey, ctx.signal);
    if (result.text.trim()) {
      transcripts.push(result.text.trim());
      detectedLanguage ||= result.languages?.[0]?.code ?? result.language ?? "";
    }
    for (const segment of result.segments ?? []) {
      const text = segment.text.trim();
      const startS = Math.min(duration, segment.start);
      const endS = Math.min(duration, segment.end);
      if (text && endS > startS)
        segments.push({ startS: offset + startS, endS: offset + endS, text });
    }
    ctx.report(
      startProgress + Math.round(((95 - startProgress) * (index + 1)) / rows.length),
      "Transcribing audio",
    );
  }

  return { language: detectedLanguage || "und", text: transcripts.join("\n"), segments };
}

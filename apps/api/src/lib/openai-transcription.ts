import { openAsBlob } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptionResult } from "@snapotter/ai";
import { runFfmpeg } from "@snapotter/media-engine";
import { z } from "zod";
import type { ToolProcessCtx } from "../routes/tool-factory.js";
import {
  findTranscriptionClips,
  makeTranscriptionWav,
  transcriptionSampleRate,
} from "./transcription-pcm.js";

const endpoint = "https://api.openai.com/v1/audio/transcriptions";
const uploadLimitBytes = 25_000_000;
const requestTimeoutMs = 5 * 60_000;
const chunkDurationS = 600;

const responseSchema = z.object({
  text: z.string(),
  languages: z.array(z.object({ code: z.string() })).optional(),
});

async function transcribeChunk(
  file: Blob,
  filename: string,
  language: string,
  apiKey: string,
  jobSignal: AbortSignal,
) {
  const form = new FormData();
  form.set("file", file, filename);
  form.set("model", "gpt-transcribe");
  form.set("response_format", "json");
  if (language !== "auto") form.set("languages[]", language);
  if (file.size > uploadLimitBytes) {
    throw new Error("Prepared audio exceeds the OpenAI transcription upload limit");
  }

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
  if (!result.success) {
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
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("OpenAI transcription is missing its API key");
  ctx.signal.throwIfAborted();

  const chunkDir = join(ctx.scratchDir, "openai-audio");
  await mkdir(chunkDir, { recursive: true });
  const chunkList = join(chunkDir, "chunks.csv");
  const extension = timed ? "pcm" : "wav";
  // Ten minutes of 16 kHz mono PCM consumes roughly 19 MB. The segment list
  // records the exact split points, which can differ from the requested times.
  await runFfmpeg(
    [
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-af",
      `aresample=${transcriptionSampleRate}:async=1:first_pts=0`,
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "segment",
      ...(timed ? ["-segment_format", "s16le"] : []),
      "-segment_time",
      String(chunkDurationS),
      "-reset_timestamps",
      "1",
      "-segment_list",
      chunkList,
      join(chunkDir, `chunk-%06d.${extension}`),
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
      !/^chunk-\d{6}\.(pcm|wav)$/.test(filename) ||
      !filename.endsWith(extension) ||
      !start ||
      !end ||
      !Number.isFinite(offset) ||
      !Number.isFinite(duration) ||
      offset < 0 ||
      duration <= 0
    ) {
      throw new Error("Could not prepare audio for OpenAI transcription");
    }
    const file = await openAsBlob(join(chunkDir, filename), {
      type: timed ? "application/octet-stream" : "audio/wav",
    });
    if (timed) {
      if (file.size % 2 !== 0) throw new Error("Invalid prepared transcription audio");
      const clips = findTranscriptionClips(await file.arrayBuffer());
      for (const clip of clips) {
        ctx.signal.throwIfAborted();
        const wav = makeTranscriptionWav(file, clip);
        const text = await transcribe(wav, "clip.wav");
        if (text) {
          segments.push({
            startS: offset + clip.start / transcriptionSampleRate,
            endS: offset + clip.end / transcriptionSampleRate,
            text: text.replace(/\s+/g, " "),
          });
        }
        const chunkProgress = Math.min(1, clip.end / transcriptionSampleRate / duration);
        reportProgress(index + chunkProgress);
      }
    } else {
      await transcribe(file, filename);
    }
    reportProgress(index + 1);
  }

  function reportProgress(completedChunks: number) {
    ctx.report(
      startProgress + Math.round(((95 - startProgress) * completedChunks) / rows.length),
      "Transcribing audio",
    );
  }

  async function transcribe(file: Blob, filename: string): Promise<string> {
    const result = await transcribeChunk(file, filename, language, apiKey, ctx.signal);
    const text = result.text.trim();
    if (text) {
      transcripts.push(text);
      detectedLanguage ||= result.languages?.[0]?.code ?? "";
    }
    return text;
  }

  return { language: detectedLanguage || "und", text: transcripts.join("\n"), segments };
}

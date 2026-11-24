export const transcriptionSampleRate = 16_000;
const sampleBytes = 2;
const frameSamples = transcriptionSampleRate / 50;
const quietSamples = transcriptionSampleRate * 0.32;
const paddingSamples = transcriptionSampleRate * 0.06;
const maxCueSamples = transcriptionSampleRate * 8;
const boundarySearchSamples = transcriptionSampleRate * 0.25;
// An RMS level around -48 dBFS marks low-energy frames as quiet.
const quietLevelSquared = (32768 * 10 ** (-48 / 20)) ** 2;
const softFloorSquared = (32768 * 10 ** (-62 / 20)) ** 2;

interface SampleRange {
  start: number;
  end: number;
}

/** Find audible intervals in mono, signed 16-bit little-endian PCM. */
export function findTranscriptionClips(pcm: ArrayBuffer): SampleRange[] {
  const samples = new DataView(pcm);
  const sampleCount = pcm.byteLength / sampleBytes;
  const energy = new Float64Array(Math.ceil(sampleCount / frameSamples));
  let peak = 0;
  for (let index = 0; index < energy.length; index++) {
    const frame = index * frameSamples;
    const end = Math.min(frame + frameSamples, sampleCount);
    let squareSum = 0;
    for (let i = frame; i < end; i++) {
      const sample = samples.getInt16(i * sampleBytes, true);
      squareSum += sample * sample;
    }
    energy[index] = squareSum / (end - frame);
    peak = Math.max(peak, energy[index]);
  }

  // Lower the threshold for quiet recordings with a measurable difference
  // between their background level and their peaks.
  let threshold = quietLevelSquared;
  if (peak < threshold) {
    const sorted = energy.slice().sort();
    const background = sorted[Math.floor(sorted.length / 5)] ?? 0;
    threshold = Math.max(softFloorSquared, background * 4, peak / 64);
  }

  const clips: SampleRange[] = [];
  let start = -1;
  let lastAudibleEnd = 0;
  for (const [index, level] of energy.entries()) {
    const frame = index * frameSamples;
    const end = Math.min(frame + frameSamples, sampleCount);
    if (level >= threshold) {
      if (start < 0) start = frame;
      lastAudibleEnd = end;
    } else if (start >= 0 && end - lastAudibleEnd >= quietSamples) {
      addClips(start, lastAudibleEnd);
      start = -1;
    }
  }
  if (start >= 0) addClips(start, lastAudibleEnd);
  return clips;

  function addClips(audibleStart: number, audibleEnd: number) {
    const paddedStart = Math.max(0, audibleStart - paddingSamples);
    const paddedEnd = Math.min(sampleCount, audibleEnd + paddingSamples);
    const clipCount = Math.ceil((paddedEnd - paddedStart) / maxCueSamples);
    let cueStart = paddedStart;
    for (let i = 1; i < clipCount; i++) {
      const target = paddedStart + Math.round(((paddedEnd - paddedStart) * i) / clipCount);
      const earliest = Math.max(
        cueStart + frameSamples,
        paddedEnd - (clipCount - i) * maxCueSamples,
        target - boundarySearchSamples,
      );
      const latest = Math.min(cueStart + maxCueSamples, target + boundarySearchSamples);
      const cueEnd = quietestBoundary(energy, target, earliest, latest);
      clips.push({ start: cueStart, end: cueEnd });
      cueStart = cueEnd;
    }
    clips.push({ start: cueStart, end: paddedEnd });
  }
}

function quietestBoundary(energy: Float64Array, target: number, earliest: number, latest: number) {
  let best = Math.max(earliest, Math.min(latest, target));
  let bestLevel =
    energy[Math.floor((best - 1) / frameSamples)] + energy[Math.floor(best / frameSamples)];
  for (let frame = Math.ceil(earliest / frameSamples); frame * frameSamples <= latest; frame++) {
    const boundary = frame * frameSamples;
    const level = energy[frame - 1] + energy[frame];
    if (
      level < bestLevel ||
      (level === bestLevel && Math.abs(boundary - target) < Math.abs(best - target))
    ) {
      best = boundary;
      bestLevel = level;
    }
  }
  return best;
}

/** Wrap a slice of FFmpeg's raw PCM output in a WAV header for the upload. */
export function makeTranscriptionWav(pcm: Blob, { start, end }: SampleRange): Blob {
  const payload = pcm.slice(start * sampleBytes, end * sampleBytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + payload.size, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(transcriptionSampleRate, 24);
  header.writeUInt32LE(transcriptionSampleRate * sampleBytes, 28);
  header.writeUInt16LE(sampleBytes, 32);
  header.writeUInt16LE(sampleBytes * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(payload.size, 40);
  return new Blob([header, payload], { type: "audio/wav" });
}

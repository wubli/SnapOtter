// Run without --live to check synthetic fixtures and list requests without an API key.
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const sharp = require("sharp");
const live = process.argv.includes("--live");
const selectedTools = process.argv.slice(2).filter((arg) => arg !== "--live");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this opt-in script is run directly with Node.
const key = process.env.OPENAI_API_KEY?.trim();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this opt-in script is run directly with Node.
const visionModel = process.env.OPENAI_EVAL_VISION_MODEL || "gpt-5.4-mini";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this opt-in script is run directly with Node.
const imageModel = process.env.OPENAI_EVAL_IMAGE_MODEL || "gpt-image-2.5-flare";
const canvas = 1024;

const scanLines = [
  "Synthetic invoice 93017",
  "Invoice total: EUR 217.53",
  "Référence: dépôt d’été",
  "日本語の請求書 5741",
  "فاتورة اختبار 4258",
  "검증 번호 5678",
];

function svgImage(body, width = canvas, height = canvas) {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
    ),
  );
}

async function scanImage(lines, blank = false) {
  return svgImage(
    `<rect width="100%" height="100%" fill="#eeeeee"/>${
      blank
        ? ""
        : lines
            .map(
              (line, i) =>
                `<text x="38" y="${60 + i * 54}" font-family="Noto Sans, sans-serif" font-size="${
                  i === 1 ? 16 : 32
                }" fill="${i === 1 ? "#555" : "#202020"}">${line}</text>`,
            )
            .join("")
    }`,
    680,
    420,
  )
    .png()
    .toBuffer();
}

function streamObject(properties, content) {
  return Buffer.concat([
    Buffer.from(`<< ${properties} /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream"),
  ]);
}

async function mixedPdf() {
  const raster = await sharp(await scanImage(["Page two: scanned text 7614"]))
    .jpeg()
    .toBuffer();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 680 420] /Contents 6 0 R /Resources << /Font << /F1 9 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 680 420] /Contents 7 0 R /Resources << /XObject << /Scan 8 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 680 420] >>",
    streamObject("", Buffer.from("BT /F1 24 Tf 38 360 Td (Page one: selectable text 5729) Tj ET")),
    streamObject("", Buffer.from("q 680 0 0 420 0 0 cm /Scan Do Q")),
    streamObject(
      "/Type /XObject /Subtype /Image /Width 680 /Height 420 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
      raster,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const blocks = [Buffer.from("%PDF-1.4\n")];
  const offsets = ["0000000000 65535 f \n"];
  let size = blocks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(size).padStart(10, "0")} 00000 n \n`);
    const block = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      Buffer.from(object),
      Buffer.from("\nendobj\n"),
    ]);
    size += block.length;
    blocks.push(block);
  }
  blocks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n${offsets.join("")}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(blocks);
}

const background = '<rect width="100%" height="100%" fill="#187194"/>';
const checker = Array.from(
  { length: 16 },
  (_, i) =>
    `<rect x="${(i % 4) * 40}" y="${Math.floor(i / 4) * 40}" width="40" height="40" fill="${i % 2 === Math.floor(i / 4) % 2 ? "#aaa" : "#eee"}"/>`,
).join("");
const subject = '<rect x="332" y="280" width="360" height="464" rx="48" fill="#f4ae35"/>';
const face =
  '<ellipse cx="512" cy="490" rx="125" ry="175" fill="#deb090"/><circle cx="462" cy="455" r="16" fill="#b00000"/><circle cx="562" cy="455" r="16" fill="#b00000"/><path d="M467 557 Q512 591 557 557" fill="none" stroke="#552c1a" stroke-width="6"/>';
const object = '<circle cx="800" cy="560" r="70" fill="#dd0066"/>';
const mark =
  '<text x="65" y="150" font-size="45" fill="black" font-family="sans-serif">AZ90</text>';
const noisy = Array.from(
  { length: 840 },
  (_, i) =>
    `<rect x="${360 + ((i * 109) % 302)}" y="${320 + ((i * 77) % 380)}" width="4" height="4" fill="${i % 2 ? "#000" : "#fff"}"/>`,
).join("");
const fullFixture = `${background}${subject}${face}${object}${mark}`;

async function pixels(buffer, region) {
  const source = sharp(buffer).ensureAlpha();
  if (region) source.extract(region);
  return source.raw().toBuffer();
}

async function samePixels(input, output, region) {
  const a = await pixels(input, region);
  const b = await pixels(output, region);
  return a.equals(b);
}

const center = { left: 332, top: 280, width: 360, height: 464 };
const stamp = { left: 60, top: 100, width: 155, height: 55 };
const target = { left: 728, top: 488, width: 144, height: 144 };
const portrait = { left: 380, top: 300, width: 264, height: 380 };
const eye = { left: 445, top: 438, width: 34, height: 34 };

function pixelAt(input, x, y) {
  return pixels(input, { left: x, top: y, width: 1, height: 1 });
}

async function samePixel(input, output, x, y) {
  return (await pixelAt(input, x, y)).equals(await pixelAt(output, x, y));
}

async function opaqueSubjectTransparentCorner(input, output) {
  return {
    subjectPreserved: await samePixels(input, output, {
      left: 412,
      top: 360,
      width: 200,
      height: 300,
    }),
    transparentCorner: (await pixelAt(output, 10, 10))[3] === 0,
  };
}

const imageCases = {
  "remove-background": {
    prompt:
      "Isolate the yellow subject and its facial illustration, removing the blue background and every element outside the yellow shape. Output transparent PNG. Preserve subject position, size and pixels exactly.",
    background: "transparent",
    check: opaqueSubjectTransparentCorner,
  },
  "remove-gif-background": {
    prompt:
      "Remove only the blue background from each frame. Keep each frame's yellow subject at its original position. Preserve all animation timings and the loop count.",
    format: "gif",
    background: "transparent",
    animated: true,
    check: async (input, output, metadata) => {
      const original = await sharp(input, { animated: true }).metadata();
      return {
        exactFrames: metadata.pages === original.pages,
        exactTiming: JSON.stringify(metadata.delay) === JSON.stringify(original.delay),
        exactLoop: metadata.loop === original.loop,
        transparentCorner: (await pixelAt(output, 10, 10))[3] === 0,
        secondFramePreserved: await samePixels(
          await sharp(input, { page: 1 }).png().toBuffer(),
          await sharp(output, { page: 1 }).png().toBuffer(),
          { left: 160, top: 440, width: 200, height: 130 },
        ),
      };
    },
  },
  "background-replace": {
    prompt:
      "Replace the blue background with pure solid green (#00ff00), keep the yellow subject and all its pixels unchanged.",
    check: async (input, output) => ({
      exactGreen: (await pixelAt(output, 10, 10)).equals(Buffer.from([0, 255, 0, 255])),
      subjectPreserved: await samePixels(input, output, center),
    }),
  },
  "blur-background": {
    fixture: `${background}<g transform="scale(6.4)">${checker}</g>${subject}${face}`,
    prompt:
      "Blur only the checkerboard background with a Gaussian blur. Preserve the yellow subject and the portrait exactly.",
    check: async (input, output) => ({
      backgroundEdgeChanged: !(await samePixel(input, output, 255, 255)),
      subjectPreserved: await samePixels(input, output, center),
    }),
  },
  "erase-object": {
    prompt:
      "Remove the pink circle in the mask and fill the hole with the neighboring solid blue. Preserve every pixel outside the mask.",
    mask: target,
    check: async (input, output) => ({
      filledWithBlue: (await pixelAt(input, 700, 560)).equals(await pixelAt(output, 800, 560)),
      unmaskedSubjectPreserved: await samePixels(input, output, center),
      unmaskedStampPreserved: await samePixels(input, output, stamp),
    }),
  },
  "ai-canvas-expand": {
    prompt:
      "Outpaint a new 256-pixel-wide strip to the RIGHT, expanding the canvas to 1280x1024. Extend the blue backdrop into that strip. Keep the original 1024x1024 pixels unchanged in their original positions.",
    width: 1280,
    check: async (input, output) => ({
      sourcePixelsExact: await samePixels(input, output, {
        left: 0,
        top: 0,
        width: 1024,
        height: 1024,
      }),
      extensionFilled: (await pixelAt(output, 1100, 512))[3] === 255,
    }),
  },
  colorize: {
    grayscale: true,
    prompt:
      "Colorize this grayscale image, with a blue background, warm yellow subject and natural portrait colors. Preserve geometry, sharp typography, and grayscale luminance.",
    check: async (input, output) => {
      const rgb = await pixelAt(output, 510, 700);
      const original = (await pixelAt(input, 510, 700))[0];
      const luminance = Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
      return {
        coloredSubject: Math.max(...rgb.subarray(0, 3)) - Math.min(...rgb.subarray(0, 3)) >= 20,
        luminancePreserved: Math.abs(luminance - original) <= 10,
        stampPreserved: await samePixels(input, output, stamp),
      };
    },
  },
  upscale: {
    width: 2048,
    height: 2048,
    prompt:
      "Upscale the input exactly 2x in both axes using detail-preserving super-resolution. Preserve typography, subject position, framing and colors.",
    check: async (input, output) => ({
      roundTripStampExact: await samePixels(
        input,
        await sharp(output).resize(1024, 1024).png().toBuffer(),
        stamp,
      ),
    }),
  },
  "enhance-faces": {
    prompt:
      "Restore detail only on the cartoon portrait inside the mask. Keep its expression, identity and framing. Leave all the unmasked input unchanged.",
    mask: portrait,
    check: async (input, output) => ({
      portraitChanged: !(await samePixels(input, output, portrait)),
      surroundingsPreserved: await samePixels(input, output, stamp),
    }),
  },
  "noise-removal": {
    fixture: `${background}${subject}${noisy}${mark}`,
    prompt:
      "Remove the small black and white noise specks inside the yellow rectangle. Keep the rectangle edge, lettering, position and colors sharp and unchanged.",
    check: async (input, output) => {
      const region = { left: 365, top: 330, width: 290, height: 360 };
      const original = await sharp(await sharp(input).extract(region).png().toBuffer()).stats();
      const edited = await sharp(await sharp(output).extract(region).png().toBuffer()).stats();
      return {
        noiseReduced: edited.channels[0].stdev < original.channels[0].stdev,
        stampPreserved: await samePixels(input, output, stamp),
      };
    },
  },
  "red-eye-removal": {
    prompt:
      "Replace the red pupils with natural dark gray pupils in the illustrated portrait. Do not change any other pixels.",
    check: async (input, output) => {
      const pupil = await pixelAt(output, 462, 455);
      return {
        pupilNeutral: Math.max(...pupil.subarray(0, 3)) - Math.min(...pupil.subarray(0, 3)) <= 20,
        nearbyFacePreserved: await samePixel(input, output, 512, 415),
        stampPreserved: await samePixels(input, output, stamp),
      };
    },
  },
  "restore-photo": {
    fixture: `${fullFixture}<path d="M450 630 L587 330" stroke="#fff" stroke-width="4"/>`,
    prompt:
      "Restore this image by repairing only the thin diagonal white scratch. Preserve the portrait and lettering.",
    check: async (input, output) => ({
      scratchRemoved: !(await samePixel(input, output, 450, 629)),
      stampPreserved: await samePixels(input, output, stamp),
    }),
  },
  "transparency-fixer": {
    fixture: `<g transform="scale(6.4)">${checker}</g>${subject}${face}`,
    prompt:
      "Remove the fake checkerboard transparency. Delete the entire checkerboard and use true PNG alpha. Keep subject pixels at their exact coordinates.",
    background: "transparent",
    check: opaqueSubjectTransparentCorner,
  },
  "passport-photo": {
    width: 720,
    height: 1024,
    prompt:
      "Produce a 720x1024 passport-style crop of this illustrated portrait with pure-white background. Preserve the identity, facial details and exact pixels of the portrait.",
    check: async (input, output) => ({
      whiteBackground: (await pixelAt(output, 10, 10)).equals(Buffer.from([255, 255, 255, 255])),
      eyeColorPreserved: (await pixelAt(input, 462, 455)).equals(await pixelAt(output, 310, 455)),
    }),
  },
  "blur-faces": {
    prompt:
      "Anonymize this synthetic image by blurring the portrait and the text AZ90. Keep the yellow shape and pink circle exact outside those regions.",
    check: async (input, output) => ({
      portraitChanged: !(await samePixels(input, output, eye)),
      textChanged: !(await samePixels(input, output, stamp)),
      unrelatedObjectPreserved: await samePixels(input, output, target),
    }),
  },
};

function normalized(text) {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

async function post(path, payload) {
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(payload instanceof FormData ? {} : { "Content-Type": "application/json" }),
    },
    body: payload instanceof FormData ? payload : JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof json?.error?.code === "string" ? json.error.code : "unknown";
    throw new Error(`OpenAI ${path} returned HTTP ${response.status} (${code})`);
  }
  return json;
}

async function recognize(content, instructions) {
  const data = await post("responses", {
    model: visionModel,
    store: false,
    max_output_tokens: 2000,
    input: [{ role: "user", content: [{ type: "input_text", text: instructions }, ...content] }],
  });
  const answer = data.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
  if (data.status !== "completed" || answer == null) {
    throw new Error("OpenAI did not return a complete OCR result");
  }
  return answer;
}

function asImage(png) {
  return {
    type: "input_image",
    image_url: `data:image/png;base64,${png.toString("base64")}`,
    detail: "high",
  };
}

async function evaluateOcr(id) {
  if (id === "ocr") {
    const [invoice, blank] = await Promise.all([scanImage(scanLines), scanImage([], true)]);
    if (!live)
      return { endpoint: "responses", requests: 2, fixtureBytes: [invoice.length, blank.length] };
    const prompt =
      "Transcribe only visible text verbatim in reading order. Preserve spelling, punctuation, digits and Unicode. If there is no text, return the literal string [EMPTY].";
    const result = await recognize([asImage(invoice)], prompt);
    const blankResult = await recognize([asImage(blank)], prompt);
    return {
      exactText: normalized(result) === normalized(scanLines.join("\n")),
      matchedLines: scanLines.filter((line) => normalized(result).includes(line)).length,
      expectedLines: scanLines.length,
      blankPage: blankResult.trim() === "[EMPTY]",
    };
  }

  const pdf = await mixedPdf();
  if (!live) return { endpoint: "responses", requests: 1, fixtureBytes: pdf.length };
  const result = await recognize(
    [
      {
        type: "input_file",
        filename: "synthetic.pdf",
        file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
      },
    ],
    "Transcribe only PDF pages 2 and 3 verbatim. Return one line per page as page_number: text. For an empty page, use [EMPTY].",
  );
  return {
    scannedPage: normalized(result).includes("2: Page two: scanned text 7614"),
    blankPage: normalized(result).includes("3: [EMPTY]"),
    unselectedTextOmitted: !result.includes("5729"),
  };
}

async function imageFixture(options) {
  if (options.animated) {
    const width = canvas;
    const height = canvas * 2;
    const frames = svgImage(
      `${background}<rect x="192" y="280" width="360" height="464" fill="#f4ae35"/>
      <rect y="1024" width="100%" height="1024" fill="#187194"/>
      <rect x="132" y="1304" width="360" height="464" fill="#f4ae35"/>`,
      width,
      height,
    );
    const rgb = await frames.removeAlpha().raw().toBuffer();
    return sharp(rgb, { raw: { width, height, pageHeight: canvas, channels: 3 } })
      .webp({ lossless: true, delay: [80, 230], loop: 3 })
      .toBuffer();
  }
  const image = svgImage(options.fixture ?? fullFixture);
  if (options.grayscale) image.grayscale().toColourspace("srgb");
  return image.png().toBuffer();
}

async function evaluateImage(options) {
  const input = await imageFixture(options);
  const mask =
    options.mask &&
    (await svgImage(
      `<path fill="#fff" fill-rule="evenodd" d="M0 0H1024V1024H0Z M${options.mask.left} ${options.mask.top}h${options.mask.width}v${options.mask.height}h-${options.mask.width}z"/>`,
    )
      .png()
      .toBuffer());
  const width = options.width ?? canvas;
  const height = options.height ?? canvas;
  const format = options.format ?? "png";
  if (!live) {
    const fixture = await sharp(input, { animated: true }).metadata();
    return {
      endpoint: "images/edits",
      requests: 1,
      fixtureBytes: input.length,
      pages: fixture.pages ?? 1,
      outputSize: `${width}x${height}`,
      ...(mask && { maskBytes: mask.length }),
    };
  }

  const form = new FormData();
  const extension = options.animated ? "webp" : "png";
  form.set("image", new Blob([input], { type: `image/${extension}` }), `synthetic.${extension}`);
  if (mask) form.set("mask", new Blob([mask], { type: "image/png" }), "synthetic-mask.png");
  form.set("model", imageModel);
  form.set("prompt", options.prompt);
  form.set("size", `${width}x${height}`);
  form.set("output_format", format);
  if (options.animated) form.set("frame_count", "2");
  form.set("quality", "medium");
  if (options.background) form.set("background", options.background);
  const result = await post("images/edits", form);
  if (!result?.data?.[0]?.b64_json) throw new Error("OpenAI did not return an encoded image");

  const output = Buffer.from(result.data[0].b64_json, "base64");
  const metadata = await sharp(output, { animated: true }).metadata();
  const dimensions =
    metadata.width === width && (metadata.pageHeight ?? metadata.height) === height;
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.pageHeight ?? metadata.height,
    exactDimensions: dimensions,
    exactFormat: metadata.format === format,
    ...(dimensions && (await options.check(input, output, metadata))),
  };
}

const allTools = ["ocr", "ocr-pdf", ...Object.keys(imageCases)];
const tools = selectedTools.length ? selectedTools : allTools;
for (const id of tools) {
  if (!allTools.includes(id)) throw new Error(`Unknown evaluation tool: ${id}`);
}
if (live && !key) throw new Error("OPENAI_API_KEY is required for --live");
console.log(JSON.stringify({ live, visionModel, imageModel }));
for (const tool of tools) {
  const started = performance.now();
  try {
    const checks =
      tool in imageCases ? await evaluateImage(imageCases[tool]) : await evaluateOcr(tool);
    console.log(
      JSON.stringify({ tool, elapsedMs: Math.round(performance.now() - started), ...checks }),
    );
    if (Object.values(checks).includes(false)) process.exitCode = 1;
  } catch (err) {
    console.log(
      JSON.stringify({
        tool,
        elapsedMs: Math.round(performance.now() - started),
        error: err.message,
      }),
    );
    process.exitCode = 1;
  }
}

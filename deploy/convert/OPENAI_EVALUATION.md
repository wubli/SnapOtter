# OpenAI capability evaluation

From a checkout with workspace dependencies installed, run the fixture and request-plan check without a credential.

```sh
node deploy/convert/evaluate-openai.mjs
```

To make billable requests, inject a restricted project key into the process environment as `OPENAI_API_KEY` and supply `--live` with the desired tool IDs. The full run makes up to three Responses calls and 15 image edit calls. The harness sends generated fixtures only and reports metrics and HTTP status without printing credentials or output media.

```sh
node deploy/convert/evaluate-openai.mjs --live ocr ocr-pdf remove-background erase-object
```

The defaults are GPT‑5.4 mini for Responses and GPT Image 2.5 Flare for Images. Set `OPENAI_EVAL_VISION_MODEL` or `OPENAI_EVAL_IMAGE_MODEL` to compare documented models or pin a snapshot. Image edits may require organization verification. Prices depend on token counts and output size. [Responses model and pricing](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [Image model and pricing](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) · [Image edit API constraints](https://developers.openai.com/api/reference/resources/images/methods/edit)

Each case probes a representative capability. A passing probe gives evidence for that input alone. All supported input types, setting values, adversarial and low-quality inputs, cancellation, size limits, output schemas, and fallback behavior would need validation before changing production availability.

| SnapOtter tool | Synthetic probe | Additional contract to validate |
| --- | --- | --- |
| Extract Text from Image | Exact multilingual invoice transcription, including small text, and a blank-image control | Multi-page TIFF, page order, supported languages and enhancement/quality settings, large/rotated inputs and blank-output warnings |
| PDF OCR | Scan and blank pages selected from a PDF with both selectable text and scans | Local page selection before sending data, readable text layer handling, page metadata, passwords, large documents and per-page failures |
| Remove Background | Transparent background pixels and exact retained subject region | Soft edges and hair, background modes, original input dimensions, and non-square or very large formats |
| Remove GIF Background | Two unequal delays, retained frame count/loop, alpha, and subject pixels in the second frame from an animated WebP | GIF and APNG ingest, APNG/WebP output, per-frame alpha, all timings and loop metadata; GIF output depends on API preview access |
| Background Replace | Exact hex color and unchanged subject pixels | Gradients, feather intensity, edge fidelity, supported formats and dimensions |
| Blur Background | Checkerboard edge changes while the subject remains identical | Blur intensity, matte edges, foreground protection and output dimensions |
| Object Eraser | Mask-guided object removal with exact sampled pixels in unmasked regions | Mask inversion, small masks, arbitrary shapes, generated transition edges and whole unmasked area equality |
| AI Canvas Expand | Requested one-sided width, opaque extension, exact original pixel region | Arbitrary edge combinations, dimensions beyond OpenAI size constraints and image context continuity |
| AI Colorization | Color introduced with retained luminance and typography | Monochrome photographic subjects, color plausibility, strength and grayscale detail |
| Image Upscaling | Exact 2× dimensions and typography fidelity after round-trip resize | Different scales, aspect ratios and output dimension caps; detail restoration without changing structure |
| Face Enhancement | Masked portrait changes and surrounding text remains unchanged | Identity and expression preservation on actual consented portrait fixtures, center-face mode and multiple people |
| Noise Removal | Measured noise reduction and retained text | Strength/detector tiers, detail preservation and performance on low-light photographs |
| Red Eye Removal | Neutral pupil sample with nearby pixels unchanged | Accurate eye localization across real photos, both eyes, sensitivity and images without red eye |
| Photo Restoration | Scratch pixel changes and unrelated lettering remains intact | Scratch region validation, identity and texture retention, different paper defects, and fidelity controls |
| PNG Transparency Fixer | Converts fake checkerboard to transparent pixels and preserves a subject region | Edge defringing, already-transparent inputs, watermark settings and lossless geometry |
| Passport Photo | Requested dimensions, white background and a known face-color landmark | The analyze endpoint, usable face landmarks, unchanged identity and jurisdiction-specific positioning and crop presets |
| Blur Faces & PII | Face and text regions change while unrelated object pixels remain unchanged | Changes alone do not establish successful redaction. Verify all face and sensitive-text regions are covered and the original content cannot be recovered. |

Mask-guided image edits are generative. The harness checks protected regions because an edit that changes the subject or original pixels can violate the tool's contract even when the output looks plausible. Vision models can misread text, especially small text or non-Latin scripts. [OpenAI vision limitations](https://developers.openai.com/api/docs/guides/images-vision#limitations)

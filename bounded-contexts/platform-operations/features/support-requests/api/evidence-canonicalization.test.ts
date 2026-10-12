// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES } from "../domain/attachment-policy";
import {
  SUPPORT_EVIDENCE_CANONICALIZATION_CONCURRENCY,
  SUPPORT_EVIDENCE_CANONICALIZATION_QUEUE_CAPACITY,
  SUPPORT_EVIDENCE_MAX_PIXELS,
  SUPPORT_EVIDENCE_RASTER_PROFILE,
  canonicalizeSupportEvidenceImage,
  createSupportEvidenceCanonicalizationQueue,
  encodeSupportEvidenceRaster,
  openSupportEvidenceCanonicalizer,
  runSupportEvidenceGoldenSelfTest,
  supportEvidenceEncoderFingerprint,
  type SupportEvidenceCanonicalImage,
  type SupportEvidenceCanonicalizationInput,
  type SupportEvidenceCanonicalizationRejection,
  type SupportEvidenceCanonicalizationResult,
  type SupportEvidenceGoldens,
} from "./evidence-canonicalization";
import committedGoldens from "./evidence-canonicalization.goldens.json" with { type: "json" };

// Counts Sharp instances and pixel decodes (toBuffer) so "rejected before decode" is proven by counts, not timing.
const decoder = vi.hoisted(() => ({ instances: 0, decodes: 0 }));
vi.mock("sharp", async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import("sharp") }>()).default;
  return {
    default: new Proxy(actual, {
      apply(target, thisArg, args: Parameters<typeof actual>) {
        decoder.instances += 1;
        const instance = Reflect.apply(target, thisArg, args) as ReturnType<typeof actual>;
        const toBuffer = instance.toBuffer.bind(instance);
        instance.toBuffer = ((...toBufferArgs: Parameters<typeof toBuffer>) => {
          decoder.decodes += 1;
          return toBuffer(...toBufferArgs);
        }) as typeof instance.toBuffer;
        return instance;
      },
    }),
  };
});

function sharpGlobalSettings() {
  const { memory, files, items } = sharp.cache();
  return { cache: [memory.max, files.max, items.max], concurrency: sharp.concurrency(), simd: sharp.simd() };
}
// Captured before any Support canonicalization runs in this process, so an idempotent global change cannot hide.
const sharpSettingsAtStart = sharpGlobalSettings();
const goldensPath = new URL("./evidence-canonicalization.goldens.json", import.meta.url);
const goldensBytesAtStart = readFileSync(goldensPath);
const goldens: SupportEvidenceGoldens = committedGoldens;
const MiB = 1024 * 1024;
const hostFingerprint = supportEvidenceEncoderFingerprint();
// F10: equality is asserted only on the production fingerprint (linux-x64 glibc); a glibc host whose fingerprint drifts fails loudly.
const productionHost = process.platform === "linux" && process.arch === "x64" && hostFingerprint.libc !== "musl";

const PATCH_SRGB = [200, 100, 50];
const RED = [255, 0, 0];
// Fixtures store a 64x48 raster with EXIF orientation 6; displayed (oriented) coordinates of its regions:
const ORIENTED = { red: [39, 8], patch: [17, 20], transparent: [17, 40], halfAlpha: [37, 40] } as const;
const STORED_PATCH = [20, 30] as const;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./__fixtures__/evidence/${name}`, import.meta.url)));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function includesAscii(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(text, "latin1"));
}

function canonical(result: SupportEvidenceCanonicalizationResult): SupportEvidenceCanonicalImage {
  if (result.kind !== "canonical") throw new Error(`expected canonical output, got ${result.code}`);
  return result.image;
}

async function counted<T>(run: () => Promise<T>): Promise<{ value: T; instances: number; decodes: number }> {
  const before = { ...decoder };
  const value = await run();
  return { value, instances: decoder.instances - before.instances, decodes: decoder.decodes - before.decodes };
}

async function pixels(body: Uint8Array, options: { keepIccProfile?: boolean } = {}) {
  const image = options.keepIccProfile ? sharp(body).keepIccProfile() : sharp(body);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return {
    info,
    data,
    at: ([x, y]: readonly [number, number]) => [
      ...data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels),
    ],
  };
}

function expectNear(actual: readonly number[], expected: readonly number[], tolerance: number) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) =>
    expect(Math.abs(value - (expected[index] ?? Number.NaN))).toBeLessThanOrEqual(tolerance),
  );
}

function jpegSegments(bytes: Uint8Array): { marker: number; data: Uint8Array }[] {
  const segments: { marker: number; data: Uint8Array }[] = [];
  for (let offset = 2; offset + 4 <= bytes.length && bytes[offset] === 0xff; ) {
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    segments.push({ marker, data: bytes.subarray(offset + 4, offset + 2 + length) });
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  return segments;
}

function pngChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let offset = 8; offset + 12 <= view.length; ) {
    const length = view.readUInt32BE(offset);
    chunks.push({
      type: view.toString("latin1", offset + 4, offset + 8),
      data: bytes.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

function riffChunkTypes(bytes: Uint8Array): string[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  for (let offset = 12; offset + 8 <= view.length; ) {
    const length = view.readUInt32LE(offset + 4);
    types.push(view.toString("latin1", offset, offset + 4));
    offset += 8 + length + (length % 2);
  }
  return types;
}

// IJG/Annex K base tables, emitted in DQT zigzag order and scaled exactly as libjpeg's jpeg_quality_scaling.
const ANNEX_K_LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const ANNEX_K_CHROMINANCE = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...Array<number>(32).fill(99),
];
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];
function qualityTable(base: readonly number[], quality: number): number[] {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return ZIGZAG.map((index) => Math.min(255, Math.max(1, Math.floor(((base[index] ?? 0) * scale + 50) / 100))));
}

function padJpegWithComments(jpeg: Uint8Array, totalBytes: number): Uint8Array {
  const maxSegmentBytes = 2 + 0xffff;
  const segments: Uint8Array[] = [];
  let remaining = totalBytes - jpeg.byteLength;
  expect(remaining).toBeGreaterThanOrEqual(4);
  while (remaining > 0) {
    const size = remaining <= maxSegmentBytes ? remaining : Math.min(maxSegmentBytes, remaining - 4);
    const segment = new Uint8Array(size);
    segment.set([0xff, 0xfe, (size - 2) >> 8, (size - 2) & 0xff]);
    segments.push(segment);
    remaining -= size;
  }
  const padded = Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
  return new Uint8Array(padded.buffer, padded.byteOffset, padded.byteLength);
}

function mpfHeaderOffset(body: Uint8Array): number {
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).indexOf("MPF\0", 0, "latin1") + 4;
}

// Both MPF fixtures' MP headers: IFD at 8 holding MPFVersion @10, NumberOfImages @22, MPEntry @34, next-IFD @46, records @50.
function patchedMpfIndex(patch: (header: DataView) => void, name = "multi-image-mpf.jpg"): Uint8Array {
  const body = fixture(name);
  patch(new DataView(body.buffer, body.byteOffset + mpfHeaderOffset(body)));
  return body;
}

// Rewrites the big-endian single-image MP header (66 bytes) with its MPEntry record at 8, ahead of its index IFD moved
// to `ifd`; at 26 only half of that IFD's next-IFD word still fits in the segment.
function relocateMpfIndex(header: DataView, ifd: number): void {
  const bytes = new Uint8Array(header.buffer, header.byteOffset, 66);
  const [table, record] = [bytes.slice(8, 50), bytes.slice(50, 66)];
  bytes.fill(0, 8);
  bytes.set(record, 8);
  bytes.set(table.subarray(0, 66 - ifd), ifd);
  header.setUint32(4, ifd);
  header.setUint32(ifd + 34, 8);
}

function withMpfSegmentLength(length: number): Uint8Array {
  const body = fixture("multi-image-mpf.jpg");
  new DataView(body.buffer, body.byteOffset).setUint16(mpfHeaderOffset(body) - 6, length);
  return body;
}

// `bytes` receives the fixture's MPF APP2 segment so a case can duplicate it.
function withBytesBeforeMpfSegment(name: string, bytes: (segment: Uint8Array) => Uint8Array): Uint8Array {
  const body = Buffer.from(fixture(name));
  const start = mpfHeaderOffset(body) - 8;
  const segment = body.subarray(start, start + 2 + body.readUInt16BE(start + 2));
  return new Uint8Array(Buffer.concat([body.subarray(0, start), bytes(segment), body.subarray(start)]));
}

const GOLDEN_INPUTS: readonly SupportEvidenceCanonicalizationInput[] = goldens.fixtures.map((entry) => ({
  body: fixture(entry.file),
  declaredContentType: entry.declaredContentType,
}));

async function goldensForThisHost(): Promise<SupportEvidenceGoldens> {
  const outputs = [];
  for (const [index, input] of GOLDEN_INPUTS.entries()) {
    const image = canonical(await canonicalizeSupportEvidenceImage(input));
    outputs.push({
      file: goldens.fixtures[index]?.file ?? "",
      contentType: image.contentType,
      sha256: image.sha256,
      byteSize: image.byteSize,
    });
  }
  return { ...goldens, fingerprints: [{ fingerprint: hostFingerprint, outputs }] };
}

function expectNoCallerMetadata(body: Uint8Array) {
  for (const marker of [
    "caller-xmp-marker",
    "caller-comment-marker",
    "caller-text-marker",
    "Exif",
    "caller-trailing-payload",
  ]) {
    expect(includesAscii(body, marker), marker).toBe(false);
  }
}

async function expectMetadataAbsent(body: Uint8Array) {
  const metadata = await sharp(body).metadata();
  expect(metadata).toMatchObject({ hasProfile: false, space: "srgb" });
  expect([metadata.exif, metadata.icc, metadata.xmp, metadata.iptc, metadata.orientation]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expectNoCallerMetadata(body);
}

describe("supportEvidenceEncoderFingerprint", () => {
  it("records the profile, resolved Sharp and libvips versions, platform, arch and libc", () => {
    expect(hostFingerprint).toEqual({
      profile: SUPPORT_EVIDENCE_RASTER_PROFILE,
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips,
      platform: process.platform,
      arch: process.arch,
      libc: process.platform === "linux" ? expect.stringMatching(/^(glibc|musl)$/) : "none",
    });
  });
});

describe("AC-B1 support-evidence-raster/v1 encodings", () => {
  it("JPEG: applies orientation, strips metadata, converts Display P3 to sRGB and emits baseline 4:4:4 quality 90", async () => {
    const body = fixture("photo-orientation-6-p3-xmp.jpg");
    expect(await sharp(body).metadata()).toMatchObject({
      orientation: 6,
      isProgressive: true,
      chromaSubsampling: "4:2:0",
      density: 300,
      icc: expect.any(Buffer),
      xmp: expect.any(Buffer),
    });

    const image = canonical(await canonicalizeSupportEvidenceImage({ body, declaredContentType: "image/jpeg" }));

    expect(image).toMatchObject({
      contentType: "image/jpeg",
      profile: SUPPORT_EVIDENCE_RASTER_PROFILE,
      fingerprint: hostFingerprint,
    });
    expect([image.sha256, image.byteSize]).toEqual([sha256(image.body), image.body.byteLength]);
    const segments = jpegSegments(image.body);
    expect(
      segments.map(({ marker }) => marker).filter((marker) => (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe),
    ).toEqual([]);
    const frame = segments.find(({ marker }) => marker === 0xc0);
    expect(segments.some(({ marker }) => marker === 0xc2)).toBe(false);
    expect(frame?.data[5]).toBe(3);
    expect([frame?.data[7], frame?.data[10], frame?.data[13]]).toEqual([0x11, 0x11, 0x11]);
    const quantization = segments.filter(({ marker }) => marker === 0xdb).map(({ data }) => [...data.subarray(1, 65)]);
    expect(quantization).toEqual([qualityTable(ANNEX_K_LUMINANCE, 90), qualityTable(ANNEX_K_CHROMINANCE, 90)]);
    expect(await sharp(image.body).metadata()).toMatchObject({
      isProgressive: false,
      chromaSubsampling: "4:4:4",
      channels: 3,
    });
    await expectMetadataAbsent(image.body);

    const output = await pixels(image.body);
    expect([output.info.width, output.info.height]).toEqual([48, 64]);
    expectNear(output.at(ORIENTED.red), RED, 12);
    expectNear(output.at(ORIENTED.patch), PATCH_SRGB, 6);
    const storedP3 = (await pixels(body, { keepIccProfile: true })).at(STORED_PATCH);
    expect(Math.max(...storedP3.map((value, index) => Math.abs(value - (PATCH_SRGB[index] ?? 0))))).toBeGreaterThan(8);
  });

  it("PNG: applies orientation, strips metadata, converts to sRGB, keeps alpha and emits truecolor at compression 9", async () => {
    const body = fixture("screenshot-alpha-orientation-6-p3-xmp.png");
    expect(await sharp(body).metadata()).toMatchObject({
      orientation: 6,
      hasAlpha: true,
      density: 300,
      icc: expect.any(Buffer),
    });
    expect(pngChunks(body).map(({ type }) => type)).toEqual(expect.arrayContaining(["iCCP", "eXIf", "tEXt", "pHYs"]));
    expect(["caller-xmp-marker", "caller-text-marker"].map((marker) => includesAscii(body, marker))).toEqual([
      true,
      true,
    ]);

    const image = canonical(await canonicalizeSupportEvidenceImage({ body, declaredContentType: "image/png" }));

    expect(image).toMatchObject({ contentType: "image/png", profile: SUPPORT_EVIDENCE_RASTER_PROFILE });
    const chunks = pngChunks(image.body);
    expect(new Set(chunks.map(({ type }) => type))).toEqual(new Set(["IHDR", "pHYs", "IDAT", "IEND"]));
    const header = chunks[0]?.data;
    expect([header?.[8], header?.[9]]).toEqual([8, 6]);
    const zlibHeader = chunks.find(({ type }) => type === "IDAT")?.data;
    expect([zlibHeader?.[0], (zlibHeader?.[1] ?? 0) >> 6]).toEqual([0x78, 3]);
    expect((await sharp(image.body).metadata()).density).not.toBe(300);
    await expectMetadataAbsent(image.body);

    const output = await pixels(image.body);
    expect([output.info.width, output.info.height, output.info.channels]).toEqual([48, 64, 4]);
    expectNear(output.at(ORIENTED.red), [...RED, 255], 2);
    expectNear(output.at(ORIENTED.patch), [...PATCH_SRGB, 255], 2);
    expect(output.at(ORIENTED.transparent)[3]).toBe(0);
    expect(output.at(ORIENTED.halfAlpha)[3]).toBe(128);
  });

  it("PNG: a paletted image with transparency becomes non-paletted truecolor with alpha", async () => {
    const body = fixture("palette-transparency.png");
    expect(pngChunks(body).map(({ type }) => type)).toEqual(expect.arrayContaining(["PLTE", "tRNS"]));

    const image = canonical(await canonicalizeSupportEvidenceImage({ body, declaredContentType: "image/png" }));

    const chunks = pngChunks(image.body);
    expect(chunks.map(({ type }) => type)).not.toContain("PLTE");
    expect([chunks[0]?.data[8], chunks[0]?.data[9]]).toEqual([8, 6]);
    const output = await pixels(image.body);
    expect(output.at([4, 4])).toEqual([...PATCH_SRGB, 255]);
    expect(output.at([20, 4])[3]).toBe(0);
  });

  it("PNG: a 16-bit Display P3 image becomes 8-bit sRGB truecolor", async () => {
    const body = fixture("rgb-16-bit-p3.png");
    expect(await sharp(body).metadata()).toMatchObject({ depth: "ushort", icc: expect.any(Buffer) });

    const image = canonical(await canonicalizeSupportEvidenceImage({ body, declaredContentType: "image/png" }));

    const header = pngChunks(image.body)[0]?.data;
    expect([header?.[8], header?.[9]]).toEqual([8, 2]);
    expectNear((await pixels(image.body)).at([8, 8]), PATCH_SRGB, 2);
    await expectMetadataAbsent(image.body);
  });

  it("WebP: applies orientation, strips metadata, converts to sRGB and emits lossless WebP that keeps alpha", async () => {
    const body = fixture("photo-alpha-orientation-6-p3-xmp.webp");
    expect(await sharp(body).metadata()).toMatchObject({ orientation: 6, hasAlpha: true, icc: expect.any(Buffer) });
    expect(riffChunkTypes(body)).toEqual(expect.arrayContaining(["VP8X", "ICCP", "ALPH", "VP8 ", "EXIF", "XMP "]));

    const image = canonical(await canonicalizeSupportEvidenceImage({ body, declaredContentType: "image/webp" }));

    expect(image).toMatchObject({ contentType: "image/webp", profile: SUPPORT_EVIDENCE_RASTER_PROFILE });
    expect(riffChunkTypes(image.body)).toEqual(["VP8L"]);
    await expectMetadataAbsent(image.body);
    const output = await pixels(image.body);
    expect([output.info.width, output.info.height, output.info.channels]).toEqual([48, 64, 4]);
    expectNear(output.at(ORIENTED.red), [...RED, 255], 12);
    expectNear(output.at(ORIENTED.patch), [...PATCH_SRGB, 255], 6);
    expect(output.at(ORIENTED.transparent)[3]).toBe(0);
    expect(output.at(ORIENTED.halfAlpha)[3]).toBe(128);
    const decodedInput = await sharp(body).autoOrient().toColourspace("srgb").withIccProfile("srgb").raw().toBuffer();
    const visibleMismatches = [...Array(48 * 64).keys()].filter(
      (pixel) =>
        decodedInput[pixel * 4 + 3] !== 0 &&
        [0, 1, 2, 3].some((channel) => decodedInput[pixel * 4 + channel] !== output.data[pixel * 4 + channel]),
    );
    expect(visibleMismatches).toEqual([]);
  });

  it("JPEG: alpha is flattened onto white before encoding", async () => {
    const width = 24;
    const height = 8;
    const raster = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const x = index % width;
      raster.set(x < 8 ? [...PATCH_SRGB, 255] : x < 16 ? [0, 0, 255, 0] : [0, 0, 0, 128], index * 4);
    }

    const body = await encodeSupportEvidenceRaster({ pixels: raster, width, height, channels: 4 }, "image/jpeg");

    const output = await pixels(body);
    expect(output.info.channels).toBe(3);
    expectNear(output.at([4, 4]), PATCH_SRGB, 4);
    expectNear(output.at([12, 4]), [255, 255, 255], 4);
    expectNear(output.at([20, 4]), [127, 127, 127], 4);
  });
});

type RejectionCase = Readonly<{
  name: string;
  input: () => SupportEvidenceCanonicalizationInput;
  code: SupportEvidenceCanonicalizationRejection;
  governs: string;
  mutant: string;
  reach: "no decoder" | "header only" | "decode";
}>;

const REJECTIONS: readonly RejectionCase[] = [
  {
    name: "a declared type outside JPEG/PNG/WebP",
    input: () => ({ body: fixture("palette-transparency.png"), declaredContentType: "image/gif" }),
    code: "unsupported-content-type",
    governs: "SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES",
    mutant: "trust any declared image type",
    reach: "no decoder",
  },
  {
    name: "empty input",
    input: () => ({ body: new Uint8Array(), declaredContentType: "image/png" }),
    code: "empty",
    governs: "body.byteLength === 0",
    mutant: "let the decoder fail on empty input",
    reach: "no decoder",
  },
  {
    name: "encoded size of 10 MiB + 1",
    input: () => ({
      body: padJpegWithComments(fixture("photo-orientation-6-p3-xmp.jpg"), SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES + 1),
      declaredContentType: "image/jpeg",
    }),
    code: "encoded-too-large",
    governs: "SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES",
    mutant: "drop the encoded-size check",
    reach: "no decoder",
  },
  {
    name: "a PNG declared as JPEG",
    input: () => ({ body: fixture("palette-transparency.png"), declaredContentType: "image/jpeg" }),
    code: "signature-mismatch",
    governs: "declared type vs JPEG signature",
    mutant: "trust the declared type",
    reach: "no decoder",
  },
  {
    name: "a JPEG declared as WebP",
    input: () => ({ body: fixture("photo-orientation-6-p3-xmp.jpg"), declaredContentType: "image/webp" }),
    code: "signature-mismatch",
    governs: "declared type vs WebP RIFF signature",
    mutant: "trust the declared type",
    reach: "no decoder",
  },
  {
    name: "a WebP declared as PNG",
    input: () => ({ body: fixture("photo-alpha-orientation-6-p3-xmp.webp"), declaredContentType: "image/png" }),
    code: "signature-mismatch",
    governs: "declared type vs PNG signature",
    mutant: "trust the declared type",
    reach: "no decoder",
  },
  {
    name: "an animated WebP",
    input: () => ({ body: fixture("animated.webp"), declaredContentType: "image/webp" }),
    code: "animated",
    governs: "VP8X animation flag",
    mutant: "decode only the first frame",
    reach: "no decoder",
  },
  {
    name: "an animated PNG",
    input: () => ({ body: fixture("animated.png"), declaredContentType: "image/png" }),
    code: "animated",
    governs: "acTL before IDAT",
    mutant: "decode only the default image",
    reach: "no decoder",
  },
  {
    name: "a JPEG whose MPF index declares two images",
    input: () => ({ body: fixture("multi-image-mpf.jpg"), declaredContentType: "image/jpeg" }),
    code: "animated",
    governs: "MPF NumberOfImages before the first scan",
    mutant: "treat indexed images as trailing data",
    reach: "no decoder",
  },
  {
    name: "a two-image MPF index behind JPEG fill bytes",
    input: () => ({
      body: withBytesBeforeMpfSegment("multi-image-mpf.jpg", () => new Uint8Array([0xff, 0xff, 0xff])),
      declaredContentType: "image/jpeg",
    }),
    code: "animated",
    governs: "fill bytes before a marker",
    mutant: "stop the marker walk at fill bytes",
    reach: "no decoder",
  },
  {
    name: "an MPF segment too short for its TIFF header",
    input: () => ({ body: withMpfSegmentLength(10), declaredContentType: "image/jpeg" }),
    code: "undecodable",
    governs: "bounds-checked MPF index",
    mutant: "read the TIFF header past the segment",
    reach: "no decoder",
  },
  {
    name: "an otherwise valid big-endian single-image MPF index whose byte order reads XX",
    input: () => ({
      body: patchedMpfIndex((header) => header.setUint16(0, 0x5858), "single-image-mpf-big-endian.jpg"),
      declaredContentType: "image/jpeg",
    }),
    code: "undecodable",
    governs: "TIFF byte order is II or MM",
    mutant: "read any byte order other than II as big-endian",
    reach: "no decoder",
  },
  // Faults in the otherwise valid big-endian single-image index; a LONG MPEntry's 16 values would need 64 bytes.
  ...(
    [
      ["an MPEntry typed LONG", (header) => header.setUint16(36, 4)],
      ["an MPEntry of TIFF type zero", (header) => header.setUint16(36, 0)],
      ["MPEntry records over the TIFF header", (header) => header.setUint32(42, 0)],
      [
        // Ending before an IFD at 24, these records overlap only the TIFF header.
        "MPEntry over the TIFF header only",
        (header) => {
          relocateMpfIndex(header, 24);
          header.setUint32(58, 2);
        },
      ],
      ["MPEntry records over the next-IFD word", (header) => header.setUint32(42, 48)],
      ["an MPF next-IFD word past its segment", (header) => relocateMpfIndex(header, 26)],
    ] as const satisfies readonly (readonly [string, (header: DataView) => void])[]
  ).map(
    ([fault, patch]): RejectionCase => ({
      name: fault,
      input: () => ({
        body: patchedMpfIndex(patch, "single-image-mpf-big-endian.jpg"),
        declaredContentType: "image/jpeg",
      }),
      code: "undecodable",
      governs: "UNDEFINED MPEntry bytes clear of the TIFF header and index IFD",
      mutant: "read MPEntry bytes of any type from any in-segment offset",
      reach: "no decoder",
    }),
  ),
  ...(
    [
      ["a TIFF magic other than 42", (header) => header.setUint16(2, 43, true)],
      ["an IFD offset past its segment", (header) => header.setUint32(4, 0xffff, true)],
      [
        // Seven entries end 12 bytes past the segment; a distinct next-IFD word keeps a duplicate tag from masking that.
        "an IFD entry count overrunning its segment",
        (header) => {
          header.setUint16(8, 7, true);
          header.setUint32(46, 0xffff, true);
        },
      ],
      ["no NumberOfImages", (header) => header.setUint16(22, 0xb0ff, true)],
      ["NumberOfImages stated twice", (header) => header.setUint16(10, 0xb001, true)],
      ["NumberOfImages that is not a LONG", (header) => header.setUint16(24, 3, true)],
      ["NumberOfImages counting two values", (header) => header.setUint32(26, 2, true)],
      [
        "zero images and zero MPEntry bytes",
        (header) => {
          header.setUint32(30, 0, true);
          header.setUint32(38, 0, true);
        },
      ],
      ["one image but two MPEntry records", (header) => header.setUint32(30, 1, true)],
      ["no MPEntry", (header) => header.setUint16(34, 0xb0ff, true)],
      ["MPEntry records past its segment", (header) => header.setUint32(42, 0xffff, true)],
    ] as const satisfies readonly (readonly [string, (header: DataView) => void])[]
  ).map(
    ([fault, patch]): RejectionCase => ({
      name: `an MPF index with ${fault}`,
      input: () => ({ body: patchedMpfIndex(patch), declaredContentType: "image/jpeg" }),
      code: "undecodable",
      governs: "bounds-checked MPF index",
      mutant: "trust or throw on a malformed MPF index",
      reach: "no decoder",
    }),
  ),
  {
    name: "a JPEG with two MPF indexes",
    input: () => ({
      body: withBytesBeforeMpfSegment("single-image-mpf-big-endian.jpg", (segment) => segment),
      declaredContentType: "image/jpeg",
    }),
    code: "undecodable",
    governs: "exactly one MPF index",
    mutant: "read only the first MPF index",
    reach: "no decoder",
  },
  {
    name: "a JPEG header segment whose length runs past the input",
    input: () => ({ body: withMpfSegmentLength(0xffff), declaredContentType: "image/jpeg" }),
    code: "undecodable",
    governs: "bounded JPEG marker walk",
    mutant: "walk past the input or leave it to the decoder",
    reach: "no decoder",
  },
  {
    name: "24,000,002 pixels",
    input: () => ({ body: fixture("bilevel-24000002-pixels.png"), declaredContentType: "image/png" }),
    code: "too-many-pixels",
    governs: "SUPPORT_EVIDENCE_MAX_PIXELS from the header",
    mutant: "rely on the decoder limit alone",
    reach: "header only",
  },
  {
    name: "a 6 KB decompression bomb of 49,000,000 pixels",
    input: () => ({ body: fixture("decompression-bomb-49000000-pixels.png"), declaredContentType: "image/png" }),
    code: "too-many-pixels",
    governs: "SUPPORT_EVIDENCE_MAX_PIXELS from the header",
    mutant: "decode before checking dimensions",
    reach: "header only",
  },
  {
    name: "a truncated WebP",
    input: () => ({ body: fixture("truncated.webp"), declaredContentType: "image/webp" }),
    code: "undecodable",
    governs: "decoder header failure",
    mutant: "swallow decoder errors",
    reach: "header only",
  },
  {
    name: "a truncated JPEG",
    input: () => ({ body: fixture("truncated.jpg"), declaredContentType: "image/jpeg" }),
    code: "undecodable",
    governs: 'failOn "warning" (truncation)',
    mutant: 'failOn "none"',
    reach: "decode",
  },
  {
    name: "a JPEG whose only fault is a decoder warning",
    input: () => ({ body: fixture("corrupt-huffman-warning.jpg"), declaredContentType: "image/jpeg" }),
    code: "undecodable",
    governs: 'failOn "warning" (bad Huffman code)',
    mutant: 'failOn "error" or "truncated"',
    reach: "decode",
  },
  {
    name: "a truncated PNG",
    input: () => ({ body: fixture("truncated.png"), declaredContentType: "image/png" }),
    code: "undecodable",
    governs: "decoder failure",
    mutant: "swallow decoder errors",
    reach: "decode",
  },
  {
    name: "canonical output above the 10 MiB budget",
    input: () => ({ body: fixture("canonical-output-over-budget.png"), declaredContentType: "image/png" }),
    code: "canonical-too-large",
    governs: "SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES on canonical bytes",
    mutant: "return canonical bytes without the budget check",
    reach: "decode",
  },
];

describe("AC-B2 rejections carry a bounded code and no bytes", () => {
  it.each(REJECTIONS)("$name -> $code ($governs; bypass mutant: $mutant)", async ({ input, code, reach }) => {
    const { value, instances, decodes } = await counted(() => canonicalizeSupportEvidenceImage(input()));

    expect(value).toStrictEqual({ kind: "rejected", code });
    if (reach === "no decoder") expect(instances).toBe(0);
    if (reach === "header only") expect(decodes).toBe(0);
  });

  it("accepts exactly 10 MiB of encoded input; the padding is metadata and never reaches canonical bytes", async () => {
    const original = fixture("photo-orientation-6-p3-xmp.jpg");
    const padded = padJpegWithComments(original, SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES);
    expect(padded.byteLength).toBe(10 * MiB);

    const image = canonical(
      await canonicalizeSupportEvidenceImage({ body: padded, declaredContentType: "image/jpeg" }),
    );

    const unpadded = canonical(
      await canonicalizeSupportEvidenceImage({ body: original, declaredContentType: "image/jpeg" }),
    );
    expect(image.sha256).toBe(unpadded.sha256);
  });

  it("accepts exactly SUPPORT_EVIDENCE_MAX_PIXELS pixels and emits truecolor RGB", async () => {
    const body = fixture("bilevel-24000000-pixels.png");

    const image = canonical(await canonicalizeSupportEvidenceImage({ body, declaredContentType: "image/png" }));

    const metadata = await sharp(image.body).metadata();
    expect([metadata.width, metadata.height, metadata.channels]).toEqual([6000, 4000, 3]);
    expect(metadata.width * metadata.height).toBe(SUPPORT_EVIDENCE_MAX_PIXELS);
    expect(pngChunks(image.body)[0]?.data[9]).toBe(2);
    expect(image.byteSize).toBeLessThanOrEqual(SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES);
  });

  it("drops a trailing polyglot payload: canonical bytes equal the clean image's", async () => {
    const polyglot = fixture("polyglot-trailing-payload.jpg");
    expect(includesAscii(polyglot, "caller-trailing-payload")).toBe(true);

    const image = canonical(
      await canonicalizeSupportEvidenceImage({ body: polyglot, declaredContentType: "image/jpeg" }),
    );

    expectNoCallerMetadata(image.body);
    expect(includesAscii(image.body, "PK\u0003\u0004")).toBe(false);
    const clean = canonical(
      await canonicalizeSupportEvidenceImage({
        body: fixture("photo-orientation-6-p3-xmp.jpg"),
        declaredContentType: "image/jpeg",
      }),
    );
    expect(Buffer.from(image.body).equals(Buffer.from(clean.body))).toBe(true);
  });

  it("multi-image-mpf.jpg indexes a second JPEG that decodes on its own", async () => {
    const body = fixture("multi-image-mpf.jpg");
    const header = new DataView(body.buffer, body.byteOffset + mpfHeaderOffset(body));
    const [size, offset] = [header.getUint32(70, true), header.getUint32(74, true)];
    const second = body.subarray(mpfHeaderOffset(body) + offset, mpfHeaderOffset(body) + offset + size);

    expect(header.getUint32(30, true)).toBe(2);
    expect(mpfHeaderOffset(body) + offset + size).toBe(body.byteLength);
    const metadata = await sharp(second).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual(["jpeg", 16, 16]);
  });

  it("accepts a single-image MPF index: canonical bytes equal the unindexed image's", async () => {
    const indexed = fixture("single-image-mpf-big-endian.jpg");
    expect(includesAscii(indexed, "MPF\0MM")).toBe(true);

    const image = canonical(
      await canonicalizeSupportEvidenceImage({ body: indexed, declaredContentType: "image/jpeg" }),
    );

    const clean = canonical(
      await canonicalizeSupportEvidenceImage({
        body: fixture("photo-orientation-6-p3-xmp.jpg"),
        declaredContentType: "image/jpeg",
      }),
    );
    expect(Buffer.from(image.body).equals(Buffer.from(clean.body))).toBe(true);
  });

  it("accepts a single-image MPF index whose MPEntry record precedes its index IFD", async () => {
    const reordered = patchedMpfIndex((header) => relocateMpfIndex(header, 24), "single-image-mpf-big-endian.jpg");
    const image = canonical(
      await canonicalizeSupportEvidenceImage({ body: reordered, declaredContentType: "image/jpeg" }),
    );

    const clean = canonical(
      await canonicalizeSupportEvidenceImage({
        body: fixture("photo-orientation-6-p3-xmp.jpg"),
        declaredContentType: "image/jpeg",
      }),
    );
    expect(Buffer.from(image.body).equals(Buffer.from(clean.body))).toBe(true);
  });
});

describe("AC-B3 determinism and fingerprint-keyed goldens", () => {
  it("binds the goldens to their base SHA, named host, production fingerprint and fixture digests", () => {
    expect(goldens.profile).toBe(SUPPORT_EVIDENCE_RASTER_PROFILE);
    expect(goldens.provenance.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(goldens.provenance.host).toMatch(/^node:24-bookworm-slim@sha256:[0-9a-f]{64} linux\/amd64/);
    expect(goldens.fixtures.map((entry) => [entry.file, sha256(fixture(entry.file))])).toEqual(
      goldens.fixtures.map((entry) => [entry.file, entry.sha256]),
    );
    expect(goldens.fingerprints.map(({ fingerprint }) => fingerprint)).toEqual([
      {
        profile: SUPPORT_EVIDENCE_RASTER_PROFILE,
        sharp: sharp.versions.sharp,
        libvips: sharp.versions.vips,
        platform: "linux",
        arch: "x64",
        libc: "glibc",
      },
    ]);
    expect(goldens.fingerprints[0]?.outputs.map(({ file }) => file)).toEqual(goldens.fixtures.map(({ file }) => file));
  });

  it("yields byte-identical output across repeated runs and permuted queue orders on this host", async () => {
    const reference = await Promise.all(
      GOLDEN_INPUTS.map(async (input) => canonical(await canonicalizeSupportEvidenceImage(input)).sha256),
    );
    const queue = createSupportEvidenceCanonicalizationQueue({ canonicalize: canonicalizeSupportEvidenceImage });
    const orders = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
    ];
    for (const order of orders) {
      const results = await Promise.all(
        order.map((index) => queue.canonicalize(GOLDEN_INPUTS[index] as SupportEvidenceCanonicalizationInput)),
      );
      expect(results.map((result) => canonical(result).sha256)).toEqual(order.map((index) => reference[index]));
    }
    for (const [index, input] of GOLDEN_INPUTS.entries()) {
      expect(canonical(await canonicalizeSupportEvidenceImage(input)).sha256).toBe(reference[index]);
    }
  });

  it.runIf(productionHost)("matches the goldens exactly under the production fingerprint", async () => {
    const certified = goldens.fingerprints[0];
    expect(hostFingerprint).toEqual(certified?.fingerprint);
    for (const [index, input] of GOLDEN_INPUTS.entries()) {
      const image = canonical(await canonicalizeSupportEvidenceImage(input));
      expect({
        file: goldens.fixtures[index]?.file,
        contentType: image.contentType,
        sha256: image.sha256,
        byteSize: image.byteSize,
      }).toEqual(certified?.outputs[index]);
    }
    await expect(runSupportEvidenceGoldenSelfTest()).resolves.toBe("passed");
  });

  it("certifies only the production fingerprint; any other fingerprint asserts determinism only", async () => {
    await expect(
      runSupportEvidenceGoldenSelfTest({ fingerprint: { ...hostFingerprint, platform: "darwin" } }),
    ).resolves.toBe("fingerprint-without-goldens");
    const opened = await openSupportEvidenceCanonicalizer({ productionLike: true });
    expect(opened.status).toBe(productionHost ? "certified" : "fingerprint-without-goldens");
  });
});

describe("AC-B4 fingerprint and startup golden self-test gate", () => {
  const photo = { body: fixture("photo-orientation-6-p3-xmp.jpg"), declaredContentType: "image/jpeg" };

  it("production-like: a fingerprint without goldens refuses canonicalizer-unavailable without decoding", async () => {
    const hostGoldens = await goldensForThisHost();
    const canonicalizer = await openSupportEvidenceCanonicalizer({
      productionLike: true,
      selfTest: () =>
        runSupportEvidenceGoldenSelfTest({
          fingerprint: { ...hostFingerprint, libvips: "0.0.0" },
          goldens: hostGoldens,
        }),
    });

    expect(canonicalizer.status).toBe("fingerprint-without-goldens");
    const { value, instances } = await counted(() => canonicalizer.canonicalize(photo));
    expect(value).toStrictEqual({ kind: "rejected", code: "canonicalizer-unavailable" });
    expect(instances).toBe(0);
  });

  it("production-like: a failing golden self-test refuses canonicalizer-unavailable", async () => {
    const hostGoldens = await goldensForThisHost();
    const [certified] = hostGoldens.fingerprints;
    const wrongOutput: SupportEvidenceGoldens = {
      ...hostGoldens,
      fingerprints: [
        {
          fingerprint: hostFingerprint,
          outputs: (certified?.outputs ?? []).map((output, index) =>
            index === 0 ? { ...output, sha256: "0".repeat(64) } : output,
          ),
        },
      ],
    };
    const changedFixture: SupportEvidenceGoldens = {
      ...hostGoldens,
      fixtures: hostGoldens.fixtures.map((entry, index) =>
        index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry,
      ),
    };

    for (const tampered of [wrongOutput, changedFixture]) {
      const canonicalizer = await openSupportEvidenceCanonicalizer({
        productionLike: true,
        selfTest: () => runSupportEvidenceGoldenSelfTest({ goldens: tampered }),
      });
      expect(canonicalizer.status).toBe("golden-mismatch");
      await expect(canonicalizer.canonicalize(photo)).resolves.toStrictEqual({
        kind: "rejected",
        code: "canonicalizer-unavailable",
      });
    }
    const throwing = await openSupportEvidenceCanonicalizer({
      productionLike: true,
      selfTest: () => Promise.reject(new Error("fixture unreadable")),
    });
    expect(throwing.status).toBe("golden-mismatch");
  });

  it("production-like: goldens that match on this host certify the canonicalizer", async () => {
    const hostGoldens = await goldensForThisHost();
    const canonicalizer = await openSupportEvidenceCanonicalizer({
      productionLike: true,
      selfTest: () => runSupportEvidenceGoldenSelfTest({ goldens: hostGoldens }),
    });

    expect(canonicalizer.status).toBe("certified");
    expect(canonical(await canonicalizer.canonicalize(photo)).fingerprint).toEqual(hostFingerprint);
  });

  it("development proceeds uncertified, records its fingerprint and never runs the self-test", async () => {
    const selfTest = vi.fn(runSupportEvidenceGoldenSelfTest);

    const canonicalizer = await openSupportEvidenceCanonicalizer({ productionLike: false, selfTest });

    expect(selfTest).not.toHaveBeenCalled();
    expect(canonicalizer).toMatchObject({ status: "uncertified-development", fingerprint: hostFingerprint });
    expect(canonical(await canonicalizer.canonicalize(photo)).fingerprint).toEqual(hostFingerprint);
  });
});

describe("AC-B5 process-wide bounded canonicalization queue", () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const request = (id: number): SupportEvidenceCanonicalizationInput => ({
    body: new Uint8Array([id]),
    declaredContentType: "image/png",
  });

  function heldCanonicalizer() {
    const started: number[] = [];
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const canonicalize = vi.fn(
      async (input: SupportEvidenceCanonicalizationInput): Promise<SupportEvidenceCanonicalizationResult> => {
        started.push(input.body[0] ?? -1);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { kind: "rejected", code: "undecodable" };
      },
    );
    return { canonicalize, started, releases, peak: () => peak };
  }

  it("never exceeds 2 concurrent decodes or 10 waiting inputs; overflow rejects busy without decoding", async () => {
    expect([SUPPORT_EVIDENCE_CANONICALIZATION_CONCURRENCY, SUPPORT_EVIDENCE_CANONICALIZATION_QUEUE_CAPACITY]).toEqual([
      2, 10,
    ]);
    const held = heldCanonicalizer();
    const queue = createSupportEvidenceCanonicalizationQueue({ canonicalize: held.canonicalize });

    const accepted = Array.from({ length: 12 }, (_, id) => queue.canonicalize(request(id)));
    await settle();
    expect(held.started).toEqual([0, 1]);
    await expect(queue.canonicalize(request(12))).resolves.toStrictEqual({ kind: "rejected", code: "busy" });
    expect(held.canonicalize).toHaveBeenCalledTimes(2);

    held.releases.shift()?.();
    await settle();
    expect(held.started).toEqual([0, 1, 2]);
    const refilled = queue.canonicalize(request(13));
    await expect(queue.canonicalize(request(14))).resolves.toStrictEqual({ kind: "rejected", code: "busy" });

    while (held.started.length < 13 || held.releases.length > 0) {
      held.releases.shift()?.();
      await settle();
    }
    await Promise.all([...accepted, refilled]);
    expect(held.started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]);
    expect(held.peak()).toBe(2);
    expect(held.canonicalize).toHaveBeenCalledTimes(13);
  });

  it("keeps the order of a 5-input batch with real decodes and at most 2 in flight", async () => {
    const startOrder: string[] = [];
    let active = 0;
    let peak = 0;
    const queue = createSupportEvidenceCanonicalizationQueue({
      async canonicalize(input) {
        startOrder.push(sha256(input.body));
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await canonicalizeSupportEvidenceImage(input);
        } finally {
          active -= 1;
        }
      },
    });

    const results = await Promise.all(GOLDEN_INPUTS.map((input) => queue.canonicalize(input)));

    expect(startOrder).toEqual(GOLDEN_INPUTS.map(({ body }) => sha256(body)));
    expect(peak).toBe(2);
    const sequential = [];
    for (const input of GOLDEN_INPUTS) sequential.push(canonical(await canonicalizeSupportEvidenceImage(input)).sha256);
    expect(results.map((result) => canonical(result).sha256)).toEqual(sequential);
  });

  it("releases the slot when canonicalization throws", async () => {
    const queue = createSupportEvidenceCanonicalizationQueue({
      canonicalize: vi
        .fn<(input: SupportEvidenceCanonicalizationInput) => Promise<SupportEvidenceCanonicalizationResult>>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ kind: "rejected", code: "undecodable" }),
    });

    const results = await Promise.allSettled([0, 1, 2, 3].map((id) => queue.canonicalize(request(id))));

    expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected", "fulfilled", "fulfilled"]);
  });
});

describe("AC-B6 Marketplace and process-global Sharp settings", () => {
  it("leaves Sharp cache, concurrency and SIMD settings and a Marketplace-shaped encode unchanged", async () => {
    const marketplaceShapedVariant = () =>
      sharp(fixture("screenshot-alpha-orientation-6-p3-xmp.png"))
        .resize({ width: 32, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    const variantBefore = await marketplaceShapedVariant();

    const queue = createSupportEvidenceCanonicalizationQueue(
      await openSupportEvidenceCanonicalizer({ productionLike: false }),
    );
    await Promise.all(GOLDEN_INPUTS.map((input) => queue.canonicalize(input)));
    await runSupportEvidenceGoldenSelfTest({ goldens: await goldensForThisHost() });

    expect(sharpGlobalSettings()).toEqual(sharpSettingsAtStart);
    expect((await marketplaceShapedVariant()).equals(variantBefore)).toBe(true);
  });
});

describe("golden immutability", () => {
  it("never rewrites the committed goldens on any host", () => {
    expect(readFileSync(goldensPath).equals(goldensBytesAtStart)).toBe(true);
  });
});

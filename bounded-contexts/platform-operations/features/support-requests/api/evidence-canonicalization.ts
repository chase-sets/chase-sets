import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import sharp, { type Channels, type Sharp } from "sharp";
import {
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
  isSupportEvidenceAttachmentContentType,
  type SupportEvidenceAttachmentContentType,
} from "../domain/attachment-policy";
import goldensJson from "./evidence-canonicalization.goldens.json" with { type: "json" };

export const SUPPORT_EVIDENCE_RASTER_PROFILE = "support-evidence-raster/v1";
export const SUPPORT_EVIDENCE_MAX_PIXELS = 24_000_000;
export const SUPPORT_EVIDENCE_CANONICALIZATION_CONCURRENCY = 2;
export const SUPPORT_EVIDENCE_CANONICALIZATION_QUEUE_CAPACITY = 10;

export type SupportEvidenceEncoderFingerprint = Readonly<{
  profile: string;
  sharp: string;
  libvips: string;
  platform: string;
  arch: string;
  libc: string;
}>;

export type SupportEvidenceCanonicalizationInput = Readonly<{ body: Uint8Array; declaredContentType: string }>;

export type SupportEvidenceCanonicalImage = Readonly<{
  body: Uint8Array;
  contentType: SupportEvidenceAttachmentContentType;
  sha256: string;
  byteSize: number;
  profile: typeof SUPPORT_EVIDENCE_RASTER_PROFILE;
  fingerprint: SupportEvidenceEncoderFingerprint;
}>;

export type SupportEvidenceCanonicalizationRejection =
  | "unsupported-content-type"
  | "empty"
  | "encoded-too-large"
  | "signature-mismatch"
  | "animated"
  | "too-many-pixels"
  | "undecodable"
  | "canonical-too-large"
  | "busy"
  | "canonicalizer-unavailable";

export type SupportEvidenceCanonicalizationResult =
  | Readonly<{ kind: "canonical"; image: SupportEvidenceCanonicalImage }>
  | Readonly<{ kind: "rejected"; code: SupportEvidenceCanonicalizationRejection }>;

export type SupportEvidenceRaster = Readonly<{ pixels: Uint8Array; width: number; height: number; channels: Channels }>;

export type SupportEvidenceGoldens = Readonly<{
  profile: string;
  provenance: Readonly<Record<string, string>>;
  fixtures: readonly Readonly<{ file: string; declaredContentType: string; sha256: string }>[];
  fingerprints: readonly Readonly<{
    fingerprint: SupportEvidenceEncoderFingerprint;
    outputs: readonly Readonly<{ file: string; contentType: string; sha256: string; byteSize: number }>[];
  }>[];
}>;

export type SupportEvidenceGoldenSelfTestOutcome = "passed" | "fingerprint-without-goldens" | "golden-mismatch";

export type SupportEvidenceCanonicalizer = Readonly<{
  status: "certified" | "uncertified-development" | Exclude<SupportEvidenceGoldenSelfTestOutcome, "passed">;
  fingerprint: SupportEvidenceEncoderFingerprint;
  canonicalize(input: SupportEvidenceCanonicalizationInput): Promise<SupportEvidenceCanonicalizationResult>;
}>;

export type SupportEvidenceCanonicalizationQueue = Pick<SupportEvidenceCanonicalizer, "canonicalize">;

const COMMITTED_GOLDENS: SupportEvidenceGoldens = goldensJson;
const GOLDEN_FIXTURES = new URL("./__fixtures__/evidence/", import.meta.url);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_ANIMATION_FLAG = 0x02;

const SIGNATURES: Readonly<Record<SupportEvidenceAttachmentContentType, (body: Uint8Array) => boolean>> = {
  "image/jpeg": (body) => startsWith(body, [0xff, 0xd8, 0xff]),
  "image/png": (body) => startsWith(body, PNG_SIGNATURE),
  "image/webp": (body) => ascii(body, 0, 4) === "RIFF" && ascii(body, 8, 12) === "WEBP",
};

// Animation lives in the container (APNG acTL, WebP VP8X flag); libvips would silently decode only the first frame.
const DECLARES_ANIMATION: Readonly<Record<SupportEvidenceAttachmentContentType, (body: Uint8Array) => boolean>> = {
  "image/jpeg": () => false,
  "image/png": (body) => pngDeclaresAnimation(body),
  "image/webp": (body) => webpDeclaresAnimation(body),
};

const DECODER_FORMATS: Readonly<Record<SupportEvidenceAttachmentContentType, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

const CANONICAL_ENCODINGS: Readonly<Record<SupportEvidenceAttachmentContentType, (image: Sharp) => Sharp>> = {
  "image/jpeg": (image) =>
    image.flatten({ background: "#ffffff" }).jpeg({ quality: 90, progressive: false, chromaSubsampling: "4:4:4" }),
  "image/png": (image) => image.png({ compressionLevel: 9, palette: false }),
  "image/webp": (image) => image.webp({ lossless: true, effort: 6 }),
};

let hostFingerprint: SupportEvidenceEncoderFingerprint | undefined;

export function supportEvidenceEncoderFingerprint(): SupportEvidenceEncoderFingerprint {
  hostFingerprint ??= Object.freeze({
    profile: SUPPORT_EVIDENCE_RASTER_PROFILE,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    platform: process.platform,
    arch: process.arch,
    libc: hostLibc(),
  });
  return hostFingerprint;
}

// Sharp picks its prebuilt binary by libc family; detect-libc reads /usr/bin/ldd first, so this does too.
function hostLibc(): string {
  if (process.platform !== "linux") return "none";
  try {
    const ldd = readFileSync("/usr/bin/ldd", "utf8");
    return ldd.includes("musl") ? "musl" : ldd.includes("GNU C Library") ? "glibc" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function canonicalizeSupportEvidenceImage(
  input: SupportEvidenceCanonicalizationInput,
): Promise<SupportEvidenceCanonicalizationResult> {
  const contentType = input.declaredContentType.trim().toLowerCase();
  if (!isSupportEvidenceAttachmentContentType(contentType)) return rejected("unsupported-content-type");
  const { body } = input;
  if (body.byteLength === 0) return rejected("empty");
  if (body.byteLength > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES) return rejected("encoded-too-large");
  if (!SIGNATURES[contentType](body)) return rejected("signature-mismatch");
  if (DECLARES_ANIMATION[contentType](body)) return rejected("animated");

  const raster = await decodeRaster(body, contentType);
  if ("code" in raster) return raster;
  const canonicalBody = await encodeSupportEvidenceRaster(raster, contentType);
  if (canonicalBody.byteLength > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES) return rejected("canonical-too-large");
  return {
    kind: "canonical",
    image: {
      body: canonicalBody,
      contentType,
      sha256: createHash("sha256").update(canonicalBody).digest("hex"),
      byteSize: canonicalBody.byteLength,
      profile: SUPPORT_EVIDENCE_RASTER_PROFILE,
      fingerprint: supportEvidenceEncoderFingerprint(),
    },
  };
}

// Encoding only the decoded raw sRGB pixels keeps every caller byte (metadata, density, trailing data) out of the output.
async function decodeRaster(
  body: Uint8Array,
  contentType: SupportEvidenceAttachmentContentType,
): Promise<SupportEvidenceRaster | Extract<SupportEvidenceCanonicalizationResult, { kind: "rejected" }>> {
  try {
    // metadata() reads headers only, so the pixel cap below applies before any pixel is decoded.
    const header = await sharp(body, { failOn: "warning", limitInputPixels: false }).metadata();
    if (header.format !== DECODER_FORMATS[contentType]) return rejected("signature-mismatch");
    if (header.width * header.height > SUPPORT_EVIDENCE_MAX_PIXELS) return rejected("too-many-pixels");
    const { data, info } = await sharp(body, { failOn: "warning", limitInputPixels: SUPPORT_EVIDENCE_MAX_PIXELS })
      .autoOrient()
      .toColourspace("srgb")
      // Sharp processes 16-bit inputs in P3; transforming to the sRGB profile converts every bit depth.
      .withIccProfile("srgb")
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    return { pixels: data, width: info.width, height: info.height, channels: info.channels };
  } catch {
    return rejected("undecodable");
  }
}

export async function encodeSupportEvidenceRaster(
  raster: SupportEvidenceRaster,
  contentType: SupportEvidenceAttachmentContentType,
): Promise<Uint8Array> {
  const { pixels, width, height, channels } = raster;
  const encoded = await CANONICAL_ENCODINGS[contentType](
    sharp(pixels, { raw: { width, height, channels } }),
  ).toBuffer();
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

export async function runSupportEvidenceGoldenSelfTest(
  options: Readonly<{ fingerprint?: SupportEvidenceEncoderFingerprint; goldens?: SupportEvidenceGoldens }> = {},
): Promise<SupportEvidenceGoldenSelfTestOutcome> {
  const fingerprint = options.fingerprint ?? supportEvidenceEncoderFingerprint();
  const goldens = options.goldens ?? COMMITTED_GOLDENS;
  const certified = goldens.fingerprints.find((entry) => sameFingerprint(entry.fingerprint, fingerprint));
  if (!certified) return "fingerprint-without-goldens";
  if (goldens.fixtures.length === 0 || certified.outputs.length !== goldens.fixtures.length) return "golden-mismatch";

  for (const fixture of goldens.fixtures) {
    const body = new Uint8Array(await readFile(new URL(fixture.file, GOLDEN_FIXTURES)));
    const expected = certified.outputs.find((output) => output.file === fixture.file);
    if (!expected || createHash("sha256").update(body).digest("hex") !== fixture.sha256) return "golden-mismatch";
    const result = await canonicalizeSupportEvidenceImage({ body, declaredContentType: fixture.declaredContentType });
    if (
      result.kind !== "canonical" ||
      result.image.contentType !== expected.contentType ||
      result.image.sha256 !== expected.sha256 ||
      result.image.byteSize !== expected.byteSize
    ) {
      return "golden-mismatch";
    }
  }
  return "passed";
}

// Production-like hosts canonicalize only under a fingerprint whose goldens match on this host; any doubt fails closed.
export async function openSupportEvidenceCanonicalizer(
  options: Readonly<{ productionLike: boolean; selfTest?: () => Promise<SupportEvidenceGoldenSelfTestOutcome> }>,
): Promise<SupportEvidenceCanonicalizer> {
  const fingerprint = supportEvidenceEncoderFingerprint();
  if (!options.productionLike) {
    return { status: "uncertified-development", fingerprint, canonicalize: canonicalizeSupportEvidenceImage };
  }
  const selfTest = options.selfTest ?? (() => runSupportEvidenceGoldenSelfTest());
  const outcome = await selfTest().catch((): SupportEvidenceGoldenSelfTestOutcome => "golden-mismatch");
  if (outcome === "passed") {
    return { status: "certified", fingerprint, canonicalize: canonicalizeSupportEvidenceImage };
  }
  return { status: outcome, fingerprint, canonicalize: async () => rejected("canonicalizer-unavailable") };
}

// One queue per process bounds decode memory: a finishing decode hands its slot straight to the oldest waiter.
export function createSupportEvidenceCanonicalizationQueue(
  canonicalizer: Pick<SupportEvidenceCanonicalizer, "canonicalize">,
): SupportEvidenceCanonicalizationQueue {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    async canonicalize(input) {
      if (active < SUPPORT_EVIDENCE_CANONICALIZATION_CONCURRENCY) active += 1;
      else if (waiting.length >= SUPPORT_EVIDENCE_CANONICALIZATION_QUEUE_CAPACITY) return rejected("busy");
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await canonicalizer.canonicalize(input);
      } finally {
        release();
      }
    },
  };
}

function webpDeclaresAnimation(body: Uint8Array): boolean {
  return ascii(body, 12, 16) === "VP8X" && ((body[20] ?? 0) & WEBP_ANIMATION_FLAG) !== 0;
}

// APNG requires acTL before the first IDAT, so the walk stops at image data.
function pngDeclaresAnimation(body: Uint8Array): boolean {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let offset = PNG_SIGNATURE.length; offset + 8 <= body.byteLength; offset += 12 + view.getUint32(offset)) {
    const type = ascii(body, offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
  }
  return false;
}

function sameFingerprint(left: SupportEvidenceEncoderFingerprint, right: SupportEvidenceEncoderFingerprint): boolean {
  return (
    left.profile === right.profile &&
    left.sharp === right.sharp &&
    left.libvips === right.libvips &&
    left.platform === right.platform &&
    left.arch === right.arch &&
    left.libc === right.libc
  );
}

function startsWith(body: Uint8Array, prefix: readonly number[]): boolean {
  return body.length >= prefix.length && prefix.every((byte, index) => body[index] === byte);
}

function ascii(body: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...body.subarray(start, end));
}

function rejected(code: SupportEvidenceCanonicalizationRejection) {
  return { kind: "rejected", code } as const;
}

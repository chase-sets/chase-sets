import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";

// Test-side builders and an independent package scanner for the journey
// package tests. Nothing here imports the packager or its contract decoder.

export const ulid = (serial) => `01JC${String(serial).padStart(22, "0")}`;
export const offerId = `off_${ulid(1)}`;
export const orderId = `ord_${ulid(2)}`;
export const eventId = `evt_${ulid(3)}`;

const buyerRoute = "/account/offers/submitted";
const sellerRoute = "/checkout/sell/session/:sessionId/confirmation";
const mobile = { width: 390, height: 844 };
const desktop = { width: 1440, height: 1000 };

// A complete v1 timeline whose entries start at `startMs` and advance one
// second at a time; the convergence window spans four seconds.
export function completeTimeline(startMs) {
  const at = (seconds) => new Date(startMs + seconds * 1000).toISOString();
  const capture = (seconds, checkpoint, route, actor, viewport) => ({
    kind: "capture",
    at: at(seconds),
    checkpoint,
    route,
    actor,
    viewport: { ...viewport },
    selectionCount: actor === "buyer" ? 1 : 0,
  });
  const command = (seconds, actor, name, offerIds) => ({
    kind: "command",
    at: at(seconds),
    actor,
    command: name,
    httpStatus: 200,
    offerIds,
  });
  return {
    contract: "market-following-command-timeline",
    version: 1,
    entries: [
      command(0, "buyer", "CreateBuyerOfferPolicy", [offerId]),
      command(1, "buyer", "PreviewBuyerOfferPolicy", [offerId]),
      capture(2, "journey-review-390", buyerRoute, "buyer", mobile),
      capture(3, "journey-review-1440", buyerRoute, "buyer", desktop),
      command(4, "buyer", "AuthorizeBuyerOfferPolicy", [offerId]),
      {
        kind: "convergence",
        startedAt: at(5),
        endedAt: at(9),
        elapsedMs: 4000,
        budgetMs: 180_000,
        pollCount: 4,
        baselineStreamVersion: 3,
        currentStreamVersion: 5,
        eventTypes: ["marketplace.offer.buyer-policy-bound", "marketplace.offer.price-updated"],
        priceUpdateVersion: 5,
        evaluationVersion: 4,
        offerId,
        amount: "12.50",
        currency: "USD",
        offerStatus: "submitted",
        outcome: "converged",
      },
      capture(10, "journey-active-390", buyerRoute, "buyer", mobile),
      capture(11, "journey-active-1440", buyerRoute, "buyer", desktop),
      {
        kind: "observation",
        at: at(12),
        observation: "target-observed",
        offerId,
        orderId: null,
        eventId,
        amount: "12.50",
        quantity: 1,
        estimateVersion: "3",
      },
      command(13, "seller", "confirm-checkout", []),
      {
        kind: "observation",
        at: at(14),
        observation: "offer-accepted",
        offerId,
        orderId,
        eventId: null,
        amount: "12.50",
        quantity: 1,
        estimateVersion: null,
      },
      capture(15, "journey-checkout-confirmation-1440", sellerRoute, "seller", desktop),
    ],
  };
}

export const checkpointWidths = {
  "journey-review-390": 390,
  "journey-review-1440": 1440,
  "journey-active-390": 390,
  "journey-active-1440": 1440,
  "journey-checkout-confirmation-1440": 1440,
};

export function pngChunk(type, data = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function ihdr(width, height, { bitDepth = 8, colorType = 6, interlace = 0 } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return pngChunk("IHDR", data);
}

// Raw scanlines: filter byte 0, then `fill` (or `text` written at the row start).
export function scanlines(width, height, { channels = 4, fill = 0x7f, text = null } = {}) {
  const rowBytes = width * channels + 1;
  const raw = Buffer.alloc(rowBytes * height, fill);
  for (let row = 0; row < height; row += 1) {
    raw[row * rowBytes] = 0;
    if (text !== null) raw.write(text, row * rowBytes + 1, "latin1");
  }
  return raw;
}

export const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A valid 8-bit RGBA PNG; `before` and `after` chunks sit around the IDAT.
export function encodePng(width, height = 2, { before = [], after = [], text = null, fill } = {}) {
  return Buffer.concat([
    pngSignature,
    ihdr(width, height),
    ...before,
    pngChunk("IDAT", deflateSync(scanlines(width, height, { text, fill }))),
    ...after,
    pngChunk("IEND"),
  ]);
}

// Pads a valid PNG to exactly `total` bytes with one private ancillary chunk.
export function padPng(png, total) {
  const padding = total - png.length - 12;
  if (padding < 0) throw new Error("PNG is already larger than the requested size");
  const headerEnd = pngSignature.length + 25;
  return Buffer.concat([
    png.subarray(0, headerEnd),
    pngChunk("prVt", Buffer.alloc(padding, 0x41)),
    png.subarray(headerEnd),
  ]);
}

export function identityEnv(overrides = {}) {
  return {
    JOURNEY_PACKAGE_PRODUCER_OUTCOME: "success",
    JOURNEY_PACKAGE_SOURCE_HEAD: "a".repeat(40),
    JOURNEY_PACKAGE_CHECKOUT_SHA: "b".repeat(40),
    JOURNEY_PACKAGE_CHECKOUT_TREE: "c".repeat(40),
    GITHUB_REF: "refs/pull/11005/merge",
    GITHUB_RUN_ID: "7001",
    GITHUB_RUN_ATTEMPT: "1",
    JOURNEY_PACKAGE_CHECK_RUN_ID: "90001",
    JOURNEY_PACKAGE_JOB_INDEX: "3",
    JOURNEY_PACKAGE_SUITE_BATCH: "marketplace_browse,marketplace_account",
    ...overrides,
  };
}

export function checkoutGit(env) {
  return (...args) => {
    if (args.at(-1) === "HEAD^{commit}") return env.JOURNEY_PACKAGE_CHECKOUT_SHA;
    if (args.at(-1) === "HEAD^{tree}") return env.JOURNEY_PACKAGE_CHECKOUT_TREE;
    return null;
  };
}

// Synthetic secret-bearing witnesses. Each carries the marker, so a
// case-insensitive marker search also finds partial copies.
export const witnessMarker = "jrnywitness";
export const witnesses = Object.freeze({
  session: "session_jrnywitness0001",
  password: "arbitrary-setup-password-jrnywitness",
  postgres: "postgres://jrnywitness:pg-jrnywitness@db.invalid:5432/cs_jrnywitness",
  bearer: "Bearer jrnywitness-bearer",
  cookie: "Cookie: cs_session=jrnywitness-cookie",
  url: "https://jrnywitness:url-jrnywitness@example.invalid/sign-in?token=jrnywitness-query#jrnywitness-fragment",
});
const witnessForms = ["session_", "postgres://", "Bearer ", "Cookie:", "token=", "#jrnywitness"];

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

function textHits(text, where) {
  const lower = text.toLowerCase();
  const hits = lower.includes(witnessMarker) ? [`${where}: marker`] : [];
  for (const form of witnessForms) if (text.includes(form)) hits.push(`${where}: ${form}`);
  return hits;
}

function jsonHits(value, where) {
  if (typeof value === "string") return textHits(value, where);
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonHits(item, `${where}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      ...textHits(key, `${where}.${key} (key)`),
      ...jsonHits(item, `${where}.${key}`),
    ]);
  }
  return [];
}

// Independent PNG walk: every chunk's type and data, plus the inflated IDAT
// stream, are searched as latin1 text.
function pngHits(bytes, where) {
  const hits = textHits(bytes.toString("latin1"), `${where} (bytes)`);
  if (!bytes.subarray(0, 8).equals(pngSignature)) return [...hits, `${where}: not a PNG`];
  const types = [];
  const idat = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    types.push(type);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const pixels = inflateSync(Buffer.concat(idat));
  return [
    ...hits,
    ...textHits(pixels.toString("latin1"), `${where} (pixels)`),
    ...types.filter((type) => !["IHDR", "IDAT", "IEND"].includes(type)).map((type) => `${where}: chunk ${type}`),
  ];
}

// Returns every witness hit in a package directory and the files it read.
export function scanPackageForWitnesses(directory) {
  const files = listFiles(directory).sort();
  const hits = files.flatMap((file) => {
    const bytes = readFileSync(path.join(directory, file));
    if (file.endsWith(".png")) return pngHits(bytes, file);
    if (file.endsWith(".json"))
      return [...textHits(bytes.toString("utf8"), file), ...jsonHits(JSON.parse(bytes), file)];
    return [`${file}: unexpected file`];
  });
  return { files, hits };
}

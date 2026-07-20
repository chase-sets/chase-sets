import type { JsonValue } from "@chase-sets/primitives/json";

// Keep Catalog events comfortably below the platform's 64 KiB payload ceiling.
// The target includes normalized observation facts and event bookkeeping; raw
// provider evidence is split into smaller, predictably sized base64 events.
export const SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES = 48 * 1024;
export const SOURCE_OBSERVATION_PAYLOAD_CHUNK_BYTES = 24 * 1024;
export const SOURCE_OBSERVATION_PAYLOAD_ENCODING = "json-utf8-base64-v1";

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function encodeSourceObservationPayloadChunks(payload: JsonValue): readonly string[] {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += SOURCE_OBSERVATION_PAYLOAD_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, offset + SOURCE_OBSERVATION_PAYLOAD_CHUNK_BYTES).toString("base64"));
  }

  // JSON.stringify(undefined) is impossible for JsonValue, and every other
  // JSON value serializes to at least one byte. Keep this invariant explicit
  // so a chunked header can never announce an empty event sequence.
  if (chunks.length === 0) {
    throw new Error("Source Observation payload serialization produced no bytes.");
  }

  return chunks;
}

export function decodeSourceObservationPayloadChunks(chunks: readonly string[]): JsonValue {
  if (chunks.length === 0) {
    throw new Error("Source Observation payload assembly requires at least one chunk.");
  }

  const serialized = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "base64"))).toString("utf8");
  return JSON.parse(serialized) as JsonValue;
}

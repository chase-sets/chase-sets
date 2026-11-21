import { timingSafeEqual } from "node:crypto";

function isSha256HexDigest(value: string): boolean {
  return value.length === 64 && !/[^0-9a-f]/.test(value);
}

export function equalSha256HexDigests(left: string | null, right: string): boolean {
  return (
    left !== null &&
    isSha256HexDigest(left) &&
    isSha256HexDigest(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

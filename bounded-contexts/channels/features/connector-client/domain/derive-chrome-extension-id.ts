import { createHash } from "node:crypto";

export function deriveChromeExtensionId(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join("");
}

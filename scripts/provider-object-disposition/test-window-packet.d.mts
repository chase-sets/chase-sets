export interface CapturePacket {
  version: "provider-lifecycle-capture/v1";
  classification: "refused" | "invalid" | "observed" | "unknown";
  replayQualified: false;
  [key: string]: unknown;
}
export function validateCapturePacket(value: unknown): value is CapturePacket;
export function parseCapturePacket(text: string): CapturePacket;

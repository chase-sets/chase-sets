import type { BrowserBoundary, CaptureDriver } from "./test-window-driver.mjs";
import type { CapturePacket } from "./test-window-packet.mjs";
export interface TestWindowRequest {
  candidateHead: string;
  manifestPath: string;
  manifestDigest: string;
}
export interface TestWindowLaunch {
  admit(
    request: TestWindowRequest,
  ): Promise<{ reviewedHead: string; executedHead: string; expiresAt: string; [key: string]: unknown }>;
  claim(request: TestWindowRequest, admission: unknown): Promise<void>;
  readFixtures(input: { signal: AbortSignal }): Promise<unknown>;
  readCredential(input: { signal: AbortSignal }): Promise<unknown>;
  open(input: {
    admission: unknown;
    fixtures: unknown;
    credential: unknown;
    browser: BrowserBoundary;
    signal: AbortSignal;
  }): Promise<CaptureDriver>;
}
export function runTestWindow(args?: string[], launch?: TestWindowLaunch): Promise<CapturePacket>;

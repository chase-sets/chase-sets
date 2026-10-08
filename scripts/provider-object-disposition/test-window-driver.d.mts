export interface BrowserBoundary {
  newContext(): Promise<unknown>;
  close(): Promise<void>;
}
export interface CaptureDriver {
  journal: { readWindow(windowId: string): Promise<unknown[]> };
  scenarios: Array<{ mapper: string; [key: string]: unknown }>;
  dispose(policy?: unknown): Promise<unknown>;
}
export function createTestWindowDriver(
  admission: { expiresAt: string },
  options: {
    browser: BrowserBoundary;
    authoritySignal?: AbortSignal;
    open(input: { browser: BrowserBoundary; signal: AbortSignal }): Promise<CaptureDriver>;
  },
): Promise<CaptureDriver>;

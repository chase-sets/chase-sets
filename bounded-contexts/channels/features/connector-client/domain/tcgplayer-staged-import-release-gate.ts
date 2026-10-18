import type { TcgplayerStagedImportFieldClassification } from "./tcgplayer-staged-import-classification";

export type TcgplayerStagedImportPhase = "initialize" | "upload" | "finalize";

export type TcgplayerStagedImportReleaseRequest = Readonly<{
  phase: TcgplayerStagedImportPhase;
  method: "POST";
  path: string;
  body: string;
  redirect: "error";
}>;

export class TcgplayerStagedImportReleaseError extends Error {
  constructor(
    readonly code:
      | "stopped"
      | "phase-released"
      | "invalid-request"
      | "body-mismatch"
      | "redirect-refused"
      | "sink-failed",
  ) {
    super(`staged-import-release-${code}`);
  }
}

type Sink = (request: TcgplayerStagedImportReleaseRequest) => void | Promise<void>;

/**
 * Immutable release boundary. The sink is the only place bytes can leave the
 * pure builder, and the latch prevents compensation/replay after any STOP.
 */
export function createTcgplayerStagedImportReleaseGate(
  input: Readonly<{
    classification: TcgplayerStagedImportFieldClassification;
    sink: Sink;
    expectedBodies?: Readonly<Partial<Record<TcgplayerStagedImportPhase, string>>>;
  }>,
): Readonly<{
  release(request: TcgplayerStagedImportReleaseRequest, expectedBody?: string): Promise<void>;
  stop(): void;
  stopped(): boolean;
}> {
  // Keep the classification in the gate's identity. It is intentionally not
  // serialized or emitted; callers pair expected bytes with this exact object.
  void input.classification;
  const released = new Set<TcgplayerStagedImportPhase>();
  let stopped = false;
  return Object.freeze({
    async release(request: TcgplayerStagedImportReleaseRequest, expectedBody?: string): Promise<void> {
      if (stopped) throw new TcgplayerStagedImportReleaseError("stopped");
      if (released.has(request.phase)) {
        stopped = true;
        throw new TcgplayerStagedImportReleaseError("phase-released");
      }
      if (request.method !== "POST" || !request.path.startsWith("/") || request.path.includes("?")) {
        stopped = true;
        throw new TcgplayerStagedImportReleaseError("invalid-request");
      }
      if (request.redirect !== "error") {
        stopped = true;
        throw new TcgplayerStagedImportReleaseError("redirect-refused");
      }
      const classifiedBody = input.expectedBodies?.[request.phase];
      if (
        (expectedBody !== undefined && request.body !== expectedBody) ||
        (classifiedBody !== undefined && request.body !== classifiedBody)
      ) {
        stopped = true;
        throw new TcgplayerStagedImportReleaseError("body-mismatch");
      }
      try {
        await input.sink(request);
      } catch {
        stopped = true;
        throw new TcgplayerStagedImportReleaseError("sink-failed");
      }
      released.add(request.phase);
    },
    stop() {
      stopped = true;
    },
    stopped: () => stopped,
  });
}

export const createStagedImportReleaseGate = createTcgplayerStagedImportReleaseGate;
export const createStagedImportRelease = createTcgplayerStagedImportReleaseGate;

import {
  buildTcgplayerStagedImportEnvelope,
  type TcgplayerStagedImportContinuation,
} from "./tcgplayer-staged-import-envelope";
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

const phasePaths: Readonly<Record<TcgplayerStagedImportPhase, string>> = Object.freeze({
  initialize: "/admin/pricing/initializeexportcsv",
  upload: "/admin/pricing/uploadexportcsv",
  finalize: "/admin/pricing/finalizeexportcsv",
});
const phaseOrder: readonly TcgplayerStagedImportPhase[] = ["initialize", "upload", "finalize"];

/**
 * Immutable release boundary. The envelope is derived once from the closed
 * classification and the sink is reached only for the mapped path/body pair.
 */
export function createTcgplayerStagedImportReleaseGate(
  input: Readonly<{
    classification: TcgplayerStagedImportFieldClassification;
    composedRows: readonly Readonly<Record<string, unknown>>[];
    continuation: TcgplayerStagedImportContinuation;
    sink: Sink;
  }>,
): Readonly<{
  release(request: TcgplayerStagedImportReleaseRequest): Promise<void>;
  stop(): void;
  stopped(): boolean;
}> {
  const envelope = buildTcgplayerStagedImportEnvelope(input);
  const expectedBodies: Readonly<Record<TcgplayerStagedImportPhase, string>> = Object.freeze(envelope);
  const released = new Set<TcgplayerStagedImportPhase>();
  let stopped = false;

  const refuse = (code: ConstructorParameters<typeof TcgplayerStagedImportReleaseError>[0]): never => {
    stopped = true;
    throw new TcgplayerStagedImportReleaseError(code);
  };

  return Object.freeze({
    async release(request: TcgplayerStagedImportReleaseRequest): Promise<void> {
      if (stopped) throw new TcgplayerStagedImportReleaseError("stopped");
      if (released.has(request.phase)) refuse("phase-released");
      if (request.method !== "POST" || request.redirect !== "error")
        refuse(request.redirect !== "error" ? "redirect-refused" : "invalid-request");
      if (request.path !== phasePaths[request.phase]) refuse("invalid-request");
      const expectedIndex = phaseOrder.indexOf(request.phase);
      if (phaseOrder.slice(0, expectedIndex).some((phase) => !released.has(phase))) refuse("invalid-request");
      if (request.body !== expectedBodies[request.phase]) refuse("body-mismatch");

      // Consume synchronously before invoking an async sink so concurrent
      // callers cannot both pass the phase check.
      released.add(request.phase);
      try {
        await input.sink(request);
      } catch {
        stopped = true;
        throw new TcgplayerStagedImportReleaseError("sink-failed");
      }
    },
    stop() {
      stopped = true;
    },
    stopped: () => stopped,
  });
}

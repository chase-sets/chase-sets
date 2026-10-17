import {
  assertLiveExportPayloadStructure,
  liveExportBounds,
  liveExportFitsLease,
  type ClaimedLiveExportOutcome,
  type liveExportUnknownReasons,
} from "../../outbound-sync/domain/live-export-codec";
import { tcgplayerLocalSnapshotRowCeiling } from "../../tcgplayer-csv/domain/contracts";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import {
  assertDerivedTcgplayerSnapshot,
  type DerivedTcgplayerSnapshot,
} from "../../tcgplayer-csv/domain/derived-snapshot";
import { liveExportAuthorityUrl, tcgplayerLiveExportAuthority } from "./live-export-authority";
import { liveExportExternalReference, type LiveExportHandoff } from "./live-export-handoff";
import { liveExportOutcome, type LiveExportExecution } from "./live-export-execution";
import { RetentionError } from "./raw-export-record";
import {
  OperationProtocolError,
  browserPayloadDigest,
  refuse,
  type ConnectorExecutor,
  type ConnectorExecutorPorts,
  type ExecutorResult,
  type LiveExportAttempt,
  type OperationUnit,
} from "./operation-protocol";

type Reason = (typeof liveExportUnknownReasons)[number];
type Ports = ConnectorExecutorPorts &
  Readonly<{
    /** Defaults to the captured authority host; hermetic harnesses pass a labelled loopback origin. */
    providerOrigin?: string;
  }>;

const authority = tcgplayerLiveExportAuthority;

/** One worker-memory download per exportId, ciphertext before handoff, handoff before parse, one derived post. */
export function createTcgplayerLiveExportExecutor(ports: Ports): ConnectorExecutor {
  const url = liveExportAuthorityUrl(ports.providerOrigin);
  const member = (unit: OperationUnit): LiveExportAttempt => {
    const [only] = unit.members;
    if (unit.members.length !== 1 || only?.operationKind !== "tcgplayer-live-export") refuse();
    return only;
  };
  const result = (attempt: LiveExportAttempt, outcome: ClaimedLiveExportOutcome["outcome"]): ExecutorResult => ({
    outcomes: [liveExportOutcome(attempt, outcome)],
  });
  const unknown = (attempt: LiveExportAttempt, reason: Reason) =>
    result(attempt, { kind: "live-export-unknown", exportId: attempt.payload.exportId, reason });
  const complete = (attempt: LiveExportAttempt, handoff: LiveExportHandoff) => {
    if (handoff.post.state !== "captured202") refuse();
    return result(attempt, {
      kind: "live-export-complete",
      exportId: attempt.payload.exportId,
      fileSha256: handoff.fileSha256,
      capturedAt: handoff.downloadedAt,
      parsedRowCount: handoff.post.parsedRowCount,
      externalReference: handoff.post.externalReference,
    });
  };

  async function download(
    attempt: LiveExportAttempt,
    signal: AbortSignal,
  ): Promise<Readonly<{ reason: "session-lost" | "download-unproven" }> | Readonly<{ bytes: Uint8Array }>> {
    const { limits, bounds } = attempt.payload;
    let response: Response;
    try {
      response = await ports.request(
        new Request(url, {
          method: authority.method,
          credentials: authority.credentials,
          redirect: authority.redirect,
          // Custody: the export plaintext stays in worker memory, never in the browser HTTP cache.
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(bounds.fetchTimeoutMs)]),
        }),
      );
    } catch {
      return { reason: "download-unproven" };
    }
    // A manual redirect or an authorization refusal is classified before any status or body validation.
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400) ||
      response.status === 401 ||
      response.status === 403
    ) {
      await response.body?.cancel().catch(() => {});
      return { reason: "session-lost" };
    }
    const declared = response.headers.get("content-length");
    if (
      response.status !== authority.status ||
      !response.url ||
      new URL(response.url).host !== url.host ||
      !/^text\/csv(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      (declared !== null && Number(declared) > limits.maxBytes) ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => {});
      return { reason: "download-unproven" };
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const zero = () => chunks.forEach((chunk) => chunk.fill(0));
    try {
      const reader = response.body.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
        length += read.value.byteLength;
        if (length > limits.maxBytes) {
          await reader.cancel().catch(() => {});
          zero();
          return { reason: "download-unproven" };
        }
      }
    } catch {
      zero();
      return { reason: "download-unproven" };
    }
    if (length < 1 || signal.aborted) {
      zero();
      return { reason: "download-unproven" };
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    zero();
    return { bytes };
  }

  /** A failed removal is a cleanup failure for the connector's pause path, never an unreadable or unproven export. */
  async function accept(rawExportId: string): Promise<void> {
    try {
      await ports.retentionStore.accept(rawExportId);
    } catch (error) {
      if (
        error instanceof OperationProtocolError ||
        (error instanceof RetentionError && error.code === "upgrade-required")
      )
        throw error;
      throw new RetentionError("cleanup-failed");
    }
  }
  /** Terminal for this exportId: the raw record leaves through the accept path before the named unknown. */
  async function retire(attempt: LiveExportAttempt, handoff: LiveExportHandoff, reason: Reason) {
    await accept(handoff.rawExportId);
    return unknown(attempt, reason);
  }

  /** Decrypts only under a live fence: a store refusal is unreadable raw, a fence failure an interruption. */
  async function readRaw(handoff: LiveExportHandoff, execution: LiveExportExecution): Promise<Uint8Array | null> {
    await execution.guard();
    try {
      return await ports.retentionStore.read(handoff.rawExportId);
    } catch (error) {
      if (error instanceof OperationProtocolError) throw error;
      return null;
    }
  }

  /** Steps 4-5 for a readable raw record; the decoded plaintext never leaves this call. */
  async function admit(
    attempt: LiveExportAttempt,
    handoff: LiveExportHandoff,
    plaintext: Uint8Array,
    signal: AbortSignal,
    execution: LiveExportExecution,
  ): Promise<ExecutorResult> {
    const { limits, bounds } = attempt.payload;
    const terminal = (reason: Reason) => retire(attempt, handoff, reason);
    let csv: string;
    try {
      csv = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      return terminal("parse-refused");
    } finally {
      plaintext.fill(0);
    }
    const parsed = parseTcgplayerFullExport({ csv, surface: "live" }, { maxRecords: limits.maxRecords });
    if (parsed.kind === "refused")
      return terminal(parsed.reason === "record-limit-exceeded" ? "cap-exceeded" : "parse-refused");
    if (
      parsed.surface !== "live" ||
      parsed.header.length !== authority.header.length ||
      parsed.header.some((column, index) => column !== authority.header[index])
    )
      return terminal("parse-refused");
    if (parsed.parsedRowCount > limits.maxRecords) return terminal("cap-exceeded");
    const snapshot: DerivedTcgplayerSnapshot = {
      parsed: { ...parsed, surface: "live" },
      fileSha256: handoff.fileSha256,
      capturedAt: handoff.downloadedAt,
    };
    const body = JSON.stringify({
      inboundKind: "export",
      externalReference: handoff.post.externalReference,
      payload: snapshot,
    });
    // Measure the whole posted envelope exactly as the ingest route's assertConnectorInbound does.
    if (new TextEncoder().encode(body).byteLength > limits.maxBytes) return terminal("cap-exceeded");
    try {
      assertDerivedTcgplayerSnapshot(snapshot, limits);
    } catch {
      return terminal("parse-refused");
    }
    let posted: LiveExportHandoff = handoff;
    if (posted.post.state === "planned") {
      posted = {
        ...posted,
        post: { ...posted.post, state: "dispatched", parsedRowCount: parsed.parsedRowCount },
      };
      await execution.save(posted);
    }
    if (posted.post.state !== "dispatched" || posted.post.parsedRowCount !== parsed.parsedRowCount) refuse();
    let admitted = false;
    try {
      const response = await execution.post(body, AbortSignal.any([signal, AbortSignal.timeout(bounds.postTimeoutMs)]));
      admitted = response.status === 202 && (await response.text()) === "{}";
    } catch (error) {
      if (error instanceof OperationProtocolError) throw error;
    }
    if (!admitted) return unknown(attempt, "admission-ambiguous");
    const captured: LiveExportHandoff = { ...posted, post: { ...posted.post, state: "captured202" } };
    await execution.save(captured);
    await accept(captured.rawExportId);
    return complete(attempt, captured);
  }

  return {
    key: "tcgplayer-live-export",
    accepts: [["tcgplayer-live-export", "live-export"]],
    unit: "operation",
    dispatchDeadlineMs: liveExportBounds.budgetMs,
    async prepare(unit) {
      const attempt = member(unit);
      const { payload } = attempt;
      try {
        assertLiveExportPayloadStructure(payload);
        if (
          attempt.connectionId !== payload.connectionId ||
          unit.reservation.connectionId !== attempt.connectionId ||
          attempt.reservationId !== unit.reservation.reservationId ||
          attempt.leaseExpiresAt !== unit.reservation.leaseExpiresAt ||
          attempt.scheduleGeneration !== payload.scheduleGeneration ||
          (await browserPayloadDigest(payload)) !== attempt.payloadDigest ||
          payload.parserProfile.headerSha256 !== (await headerSha256()) ||
          payload.limits.maxRecords > tcgplayerLocalSnapshotRowCeiling ||
          payload.bounds.budgetMs > liveExportBounds.budgetMs ||
          !liveExportFitsLease(payload.bounds.budgetMs, Date.parse(attempt.leaseExpiresAt) - ports.clock.now())
        )
          throw new OperationProtocolError("protocol-violation");
      } catch {
        return { ready: false, result: unknown(attempt, "authority-unavailable") };
      }
      return { ready: true };
    },
    async dispatchOnce(unit, signal, _pull, _stagedImport, execution) {
      const attempt = member(unit);
      if (!execution || attempt.handoff) refuse();
      const { payload } = attempt;
      const budget = AbortSignal.any([signal, AbortSignal.timeout(payload.bounds.budgetMs)]);
      await execution.guard();
      const fetched = await download(attempt, budget);
      if (!("bytes" in fetched)) return unknown(attempt, fetched.reason);
      const downloadedAt = new Date(ports.clock.now()).toISOString();
      const byteLength = fetched.bytes.byteLength;
      let fileSha256: string;
      try {
        await execution.guard();
        ({ digest: fileSha256 } = await ports.retentionStore.write({
          rawExportId: payload.exportId,
          connectionId: payload.connectionId,
          downloadedAt,
          bytes: fetched.bytes,
          maxBytes: payload.limits.maxBytes,
        }));
      } catch (error) {
        if (error instanceof OperationProtocolError) throw error;
        return unknown(attempt, "download-unproven");
      } finally {
        fetched.bytes.fill(0);
      }
      const handoff: LiveExportHandoff = {
        rawExportId: payload.exportId,
        fileSha256,
        downloadedAt,
        byteLength,
        post: {
          externalReference: await liveExportExternalReference(payload.connectionId, payload.exportId, fileSha256),
          state: "planned",
        },
      };
      await execution.save(handoff);
      const plaintext = await readRaw(handoff, execution);
      if (!plaintext) return retire(attempt, handoff, "raw-unreadable");
      return admit(attempt, handoff, plaintext, budget, execution);
    },
    async reconcileAmbiguous(unit, _pull, execution) {
      const attempt = member(unit);
      const handoff = attempt.handoff;
      // Never fetch inside an ambiguous operation; only the scheduler's next boundary mints a new exportId.
      if (!handoff) return null;
      if (!execution) refuse();
      await execution.guard();
      if (handoff.post.state === "captured202") {
        await accept(handoff.rawExportId);
        return complete(attempt, handoff);
      }
      const plaintext = await readRaw(handoff, execution);
      // A retried terminal cleanup lands here once its record is refused; accept again rather than strand it.
      if (!plaintext) return retire(attempt, handoff, "raw-unreadable");
      return admit(attempt, handoff, plaintext, AbortSignal.timeout(attempt.payload.bounds.budgetMs), execution);
    },
  };
}

async function headerSha256(): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authority.header.join("\n")));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

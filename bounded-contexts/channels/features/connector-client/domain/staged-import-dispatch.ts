import { canonicalJson } from "../../outbound-sync/domain/validation";
import { closedRecord, connectorValue } from "./extension-records";
import { OperationProtocolError } from "./operation-codec";
import type { OperationUnit } from "./operation-protocol";
import type { OperationJournal } from "../integrations/connector-indexeddb";
import { assertStagedImportFit, decodeStagedImportCapturePlan, stagedImportProtocolCost } from "./staged-import-fit";
import {
  decodeStagedImportDispatchPolicyResponse,
  StagedImportDispatchError,
  type StagedImportDispatchPolicyResponse,
} from "../../connector-feed/domain/staged-import-dispatch-policy";

export type StagedImportTiming = Readonly<{
  schemaVersion: 1;
  epoch: string;
  owner: string;
  state: "admitted" | "intent" | "completed" | "released" | "unknown";
  intervalMs: number;
  dispatchDeadlineMs: number;
  lastStart: number | null;
  lastCompletion: number | null;
  requestIndex: number;
  planDigest: string;
}>;
export type StagedImportPreparation = Readonly<{ plan: unknown; batchDigest: string; composedRows: number }>;
export type StagedImportSend = Readonly<{ send(requestId: string, request: Request): Promise<Response> }>;

export function parseStagedImportTiming(input: unknown): StagedImportTiming {
  const value = closedRecord(input, [
    "schemaVersion",
    "epoch",
    "owner",
    "state",
    "intervalMs",
    "dispatchDeadlineMs",
    "lastStart",
    "lastCompletion",
    "requestIndex",
    "planDigest",
  ]);
  if (value.schemaVersion !== 1) throw new OperationProtocolError("upgrade-required");
  for (const key of ["epoch", "owner"]) connectorValue(value[key]);
  if (
    !["admitted", "intent", "completed", "released", "unknown"].includes(String(value.state)) ||
    !Number.isSafeInteger(value.intervalMs) ||
    Number(value.intervalMs) < 60000 ||
    Number(value.intervalMs) > 600000 ||
    !Number.isSafeInteger(value.dispatchDeadlineMs) ||
    Number(value.dispatchDeadlineMs) < 1000 ||
    Number(value.dispatchDeadlineMs) > 600000 ||
    !Number.isSafeInteger(value.requestIndex) ||
    Number(value.requestIndex) < 0 ||
    Number(value.requestIndex) > 4096 ||
    typeof value.planDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.planDigest)
  )
    throw new OperationProtocolError("incomplete-authority");
  for (const key of ["lastStart", "lastCompletion"])
    if (value[key] !== null && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0))
      throw new OperationProtocolError("incomplete-authority");
  if (
    (value.state === "admitted" &&
      (value.lastStart !== null || value.lastCompletion !== null || value.requestIndex !== 0)) ||
    (value.state === "intent" && (value.lastStart === null || value.lastCompletion !== null)) ||
    (value.state === "completed" &&
      (value.lastStart === null || value.lastCompletion === null || value.requestIndex === 0)) ||
    (value.state === "released" &&
      (value.requestIndex === 0
        ? value.lastStart !== null || value.lastCompletion !== null
        : value.lastStart === null || value.lastCompletion === null)) ||
    (value.lastCompletion !== null &&
      (value.lastStart === null || Number(value.lastCompletion) < Number(value.lastStart)))
  )
    throw new OperationProtocolError("incomplete-authority");
  return structuredClone(value) as StagedImportTiming;
}

export function assertStagedImportTimingTransition(
  before: StagedImportTiming,
  after: StagedImportTiming | undefined,
): void {
  if (
    before.state === "admitted" &&
    before.lastStart === null &&
    before.requestIndex === 0 &&
    after?.state === "admitted" &&
    after.lastStart === null &&
    after.lastCompletion === null &&
    after.requestIndex === 0
  )
    return;
  if (
    !after ||
    before.epoch !== after.epoch ||
    before.owner !== after.owner ||
    before.planDigest !== after.planDigest ||
    before.intervalMs !== after.intervalMs ||
    before.dispatchDeadlineMs !== after.dispatchDeadlineMs
  )
    throw new OperationProtocolError("stale-fence");
  if (canonicalJson(before) === canonicalJson(after)) return;
  const intent =
    (before.state === "admitted" || before.state === "completed") &&
    after.state === "intent" &&
    after.requestIndex === before.requestIndex &&
    after.lastStart !== null &&
    after.lastCompletion === null &&
    (before.lastCompletion === null ||
      after.lastStart >= Math.max(before.lastStart! + before.intervalMs, before.lastCompletion));
  const completion =
    before.state === "intent" &&
    after.state === "completed" &&
    after.requestIndex === before.requestIndex + 1 &&
    after.lastStart !== null &&
    after.lastStart >= before.lastStart! &&
    after.lastCompletion !== null &&
    after.lastCompletion >= after.lastStart;
  const release =
    (before.state === "completed" || (before.state === "admitted" && before.requestIndex === 0)) &&
    after.state === "released" &&
    after.requestIndex === before.requestIndex &&
    after.lastStart === before.lastStart &&
    after.lastCompletion === before.lastCompletion;
  if (!intent && !completion && !release) throw new OperationProtocolError("stale-fence");
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function stagedImportMembershipDigest(unit: OperationUnit): Promise<string> {
  return digest(
    unit.members
      .map((member) => [member.operationId, member.attemptId, member.claimGeneration, member.payloadDigest])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)),
  );
}

export async function prepareStagedImportDispatch(
  ports: Readonly<{
    unit: OperationUnit;
    preparation: StagedImportPreparation | undefined;
    dispatchDeadlineMs: number;
    epoch: string;
    platformOrigin: string;
    accessToken: string;
    request(request: Request): Promise<Response>;
    monotonic(): number;
    wait(ms: number, signal: AbortSignal): Promise<void>;
    current(): OperationJournal;
    fence(): Promise<boolean>;
    save(timing: StagedImportTiming): Promise<void>;
  }>,
) {
  const plan = decodeStagedImportCapturePlan(ports.preparation?.plan);
  const unit = ports.unit;
  if (
    plan.connectionId !== unit.reservation.connectionId ||
    plan.reservationId !== unit.reservation.reservationId ||
    plan.pairingId !== unit.reservation.pairingId ||
    plan.executorKey !== unit.reservation.executorKey ||
    plan.membershipDigest !== (await stagedImportMembershipDigest(unit)) ||
    plan.batchDigest !== ports.preparation?.batchDigest ||
    plan.composedRows !== ports.preparation?.composedRows
  )
    throw new StagedImportDispatchError("staged-import-plan-unavailable");
  const started = ports.monotonic();
  let lastClock = started;
  const deadline = started + ports.dispatchDeadlineMs;
  let sent = 0;
  let busy = false;
  let stopped = false;
  let policyRevision: string | undefined;
  let policyStarted = started;
  let timing: StagedImportTiming;
  function clock() {
    const now = ports.monotonic();
    if (!Number.isFinite(now) || now < lastClock || now - started > ports.dispatchDeadlineMs)
      throw new StagedImportDispatchError(sent ? "staged-import-outcome-unknown" : "staged-import-fit-refused");
    lastClock = now;
    return now;
  }
  async function freshPolicy() {
    const requestNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    policyStarted = clock();
    const signal = AbortSignal.timeout(plan.platformReadMs);
    const response = await Promise.race([
      ports
        .request(
          new Request(
            `${ports.platformOrigin}/channel-connector/oauth/tcgplayer-staged-import-dispatch-policy?${new URLSearchParams({ reservationId: plan.reservationId, requestNonce })}`,
            { redirect: "error", signal, headers: { Authorization: `Bearer ${ports.accessToken}` } },
          ),
        )
        .then(async (response) => ({ ok: response.ok, text: await response.text() })),
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new StagedImportDispatchError("staged-import-policy-unavailable")),
          { once: true },
        ),
      ),
    ]);
    if (!response.ok) throw new StagedImportDispatchError("staged-import-policy-unavailable");
    const text = response.text;
    if (text.length > 8192) throw new StagedImportDispatchError("staged-import-policy-unavailable");
    let next: StagedImportDispatchPolicyResponse;
    try {
      next = decodeStagedImportDispatchPolicyResponse(JSON.parse(text));
    } catch {
      throw new StagedImportDispatchError("staged-import-policy-unavailable");
    }
    if (
      next.connectionId !== plan.connectionId ||
      next.pairingId !== plan.pairingId ||
      next.reservationId !== plan.reservationId ||
      next.requestNonce !== requestNonce ||
      (policyRevision && next.policy.revision !== policyRevision) ||
      clock() - policyStarted > plan.platformReadMs ||
      clock() - policyStarted >= 60000
    )
      throw new StagedImportDispatchError("staged-import-policy-unavailable");
    policyRevision = next.policy.revision;
    return next;
  }
  function fresh() {
    const elapsed = clock() - policyStarted;
    if (
      elapsed >= 60000 ||
      (policy.policy.effectiveUntil !== null &&
        elapsed >= Date.parse(policy.policy.effectiveUntil) - Date.parse(policy.policy.resolvedAt))
    )
      throw new StagedImportDispatchError("staged-import-policy-unavailable");
  }
  function fit(wait: number, currentReadComplete = false) {
    const now = clock();
    const remainingRequests = plan.requests.slice(sent);
    const overhead =
      Math.max(0, remainingRequests.length - Number(currentReadComplete)) * plan.platformReadMs +
      plan.parsingMs +
      plan.reportMs;
    assertStagedImportFit({
      costMs: stagedImportProtocolCost(
        policy.policy.value.minimumRequestStartIntervalSeconds * 1000,
        remainingRequests.map((hop) => hop.maximumDurationMs),
        wait,
        overhead,
      ),
      remainingMs: deadline - now,
      dispatchDeadlineMs: ports.dispatchDeadlineMs,
      now: Date.parse(policy.policy.resolvedAt) + (now - policyStarted),
      leaseExpiresAt: Date.parse(unit.reservation.leaseExpiresAt),
      policyRemainingMs:
        policy.policy.effectiveUntil === null
          ? Infinity
          : Date.parse(policy.policy.effectiveUntil) - Date.parse(policy.policy.resolvedAt) - (now - policyStarted),
    });
  }
  let policy = await freshPolicy();
  fresh();
  const intervalMs = policy.policy.value.minimumRequestStartIntervalSeconds * 1000;
  const previous = ports.current().reservations.flatMap((row) => (row.stagedImport ? [row.stagedImport] : []));
  if (
    ports
      .current()
      .reservations.some(
        (row) =>
          row.stagedImport &&
          row.stagedImport.state !== "released" &&
          !(
            row.reservationId === unit.reservation.reservationId &&
            row.phase === "prepared" &&
            row.stagedImport.state === "admitted" &&
            row.stagedImport.lastStart === null
          ),
      )
  )
    throw new StagedImportDispatchError("staged-import-authority-refused");
  const qualified = previous.filter(
    (row) =>
      row.epoch === ports.epoch &&
      row.lastStart !== null &&
      row.lastCompletion !== null &&
      clock() >= row.lastCompletion &&
      clock() - row.lastStart <= row.dispatchDeadlineMs,
  );
  let eligible = qualified.length
    ? Math.max(
        ...qualified.map((row) => Math.max(row.lastStart! + Math.max(intervalMs, row.intervalMs), row.lastCompletion!)),
      )
    : clock() + intervalMs;
  fit(Math.max(0, eligible - clock()));
  timing = {
    schemaVersion: 1,
    epoch: ports.epoch,
    owner: crypto.randomUUID(),
    state: "admitted",
    intervalMs,
    dispatchDeadlineMs: ports.dispatchDeadlineMs,
    lastStart: null,
    lastCompletion: null,
    requestIndex: 0,
    planDigest: await digest(plan),
  };
  if (!(await ports.fence())) throw new StagedImportDispatchError("staged-import-authority-refused");
  await ports.save(timing);
  if (!qualified.length) eligible = clock() + intervalMs;

  return {
    async send(requestId: string, request: Request, signal: AbortSignal): Promise<Response> {
      if (
        busy ||
        stopped ||
        signal.aborted ||
        !plan.composedRows ||
        plan.requests[sent]?.requestId !== requestId ||
        new URL(request.url).origin === ports.platformOrigin ||
        request.redirect !== "error"
      )
        throw new StagedImportDispatchError("staged-import-authority-refused");
      busy = true;
      try {
        const hop = plan.requests[sent];
        const wait = Math.max(0, eligible - clock());
        if (wait) await ports.wait(wait, signal);
        if (clock() < eligible) throw new StagedImportDispatchError("staged-import-fit-refused");
        policy = await freshPolicy();
        fresh();
        fit(0, true);
        if (signal.aborted || !(await ports.fence()))
          throw new StagedImportDispatchError("staged-import-authority-refused");
        timing = { ...timing, state: "intent", lastStart: clock(), lastCompletion: null, requestIndex: sent };
        await ports.save(timing);
        if (signal.aborted || !(await ports.fence()))
          throw new StagedImportDispatchError("staged-import-authority-refused");
        fresh();
        fit(0, true);
        const actualStart = clock();
        sent += 1;
        const timeout = AbortSignal.timeout(hop.maximumDurationMs);
        const combined = AbortSignal.any([signal, request.signal, timeout]);
        const response = await Promise.race([
          (async () => {
            const response = await ports.request(new Request(request, { signal: combined }));
            const body = await response.arrayBuffer();
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          })(),
          new Promise<never>((_resolve, reject) =>
            combined.addEventListener(
              "abort",
              () => reject(new StagedImportDispatchError("staged-import-outcome-unknown")),
              { once: true },
            ),
          ),
        ]);
        const completion = clock();
        if (combined.aborted || completion - actualStart > hop.maximumDurationMs || !(await ports.fence()))
          throw new StagedImportDispatchError("staged-import-outcome-unknown");
        timing = {
          ...timing,
          state: "completed",
          lastStart: actualStart,
          lastCompletion: completion,
          requestIndex: sent,
        };
        await ports.save(timing);
        eligible = Math.max(actualStart + intervalMs, completion);
        return response;
      } catch (error) {
        stopped = true;
        // An intent with no completion is never released, including cancellation before the network call.
        if (sent || timing.state === "intent") throw new StagedImportDispatchError("staged-import-outcome-unknown");
        throw error;
      } finally {
        busy = false;
      }
    },
    async finish() {
      if (stopped || busy || sent !== plan.requests.length || !(await ports.fence()))
        throw new StagedImportDispatchError("staged-import-outcome-unknown");
      const completed = clock();
      if (
        completed + plan.reportMs > deadline ||
        (policy.policy.effectiveUntil !== null &&
          completed - policyStarted + plan.reportMs >=
            Date.parse(policy.policy.effectiveUntil) - Date.parse(policy.policy.resolvedAt))
      )
        throw new StagedImportDispatchError("staged-import-outcome-unknown");
      timing = { ...timing, state: "released" };
      await ports.save(timing);
    },
  };
}

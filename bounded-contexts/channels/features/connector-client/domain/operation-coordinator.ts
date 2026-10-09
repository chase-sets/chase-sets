import { canonicalJson } from "../../outbound-sync/domain/validation";
import { RetentionError } from "./raw-export-record";
import type { ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import type { ConnectorReport } from "../../connector-feed/domain/transport";
import { createOperationJournal, type OperationJournal } from "../integrations/operation-indexeddb";
import {
  OperationProtocolError,
  assertTotalResult,
  browserPayloadDigest,
  identifier,
  nextRevision,
  parseExecutorResult,
  parseOperationClaim,
  record,
  refuse,
  type ConnectorExecutor,
  type ExecutorResult,
  type OperationAttempt,
  type OperationReservation,
  type OperationUnit,
} from "./operation-protocol";

export type CoordinatorInput = Readonly<{
  connectionId: string;
  accessToken: string;
  reason?: "boot" | "update" | "work" | "unpair";
  authority?: () => Promise<"paired-idle" | "report-only" | "absent">;
}>;
export type CoordinatorResult = Readonly<{
  outcome:
    | "ok"
    | "authorization-refused"
    | "revoked"
    | "invalid-credential"
    | "unknown"
    | "upgrade-required"
    | "protocol-violation"
    | "unsupported-operation";
  pollWindowSeconds?: number;
}>;
type Ports = Readonly<{
  indexedDB: IDBFactory;
  keyRange: typeof IDBKeyRange;
  executors: readonly ConnectorExecutor[];
  platformOrigin: string;
  request(request: Request): Promise<Response>;
  clock: Readonly<{ now(): number }>;
}>;

export function createConnectorOperationCoordinator(ports: Ports) {
  const journal = createOperationJournal(ports.indexedDB, ports.keyRange);
  const executors = new Map<string, ConnectorExecutor>();
  const pairs = new Set<string>();
  for (const executor of ports.executors) {
    identifier(executor.key);
    if (
      executor.key === "unsupported" ||
      executors.has(executor.key) ||
      !["operation", "reservation"].includes(executor.unit) ||
      !Number.isSafeInteger(executor.dispatchDeadlineMs) ||
      executor.dispatchDeadlineMs < 1000 ||
      executor.dispatchDeadlineMs > 600000 ||
      !executor.accepts.length
    )
      refuse();
    for (const pair of executor.accepts) {
      const key = canonicalJson(pair);
      if (
        pairs.has(key) ||
        !(
          (pair[0] === "delist" && pair[1] === "delist") ||
          (["publish", "update"].includes(pair[0]) && pair[1] === "draft")
        )
      )
        refuse();
      pairs.add(key);
    }
    executors.set(executor.key, executor);
  }
  const origin = new URL(ports.platformOrigin);
  if (
    origin.origin !== ports.platformOrigin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
  )
    refuse();
  const instant = () => new Date(ports.clock.now()).toISOString();
  const revise = <T extends { revision: number }>(row: T, patch: Partial<T>): T => ({
    ...row,
    ...patch,
    revision: nextRevision(row.revision),
  });
  function unit(state: OperationJournal, reservation: OperationReservation): OperationUnit {
    return {
      reservation,
      members: reservation.memberOperationIds.map((id) => state.members.find((member) => member.operationId === id)!),
    };
  }
  async function write(
    input: CoordinatorInput,
    state: OperationJournal,
    reservation: OperationReservation,
    members: readonly OperationAttempt[],
  ) {
    const ids = new Set(members.map((member) => member.operationId));
    return journal.change(input.connectionId, state, {
      reservations: state.reservations.map((row) =>
        row.reservationId === reservation.reservationId ? reservation : row,
      ),
      members: state.members.map((row) =>
        ids.has(row.operationId) ? members.find((member) => member.operationId === row.operationId)! : row,
      ),
    });
  }
  async function request(input: CoordinatorInput, action: "claim" | "report", body: object) {
    return ports.request(
      new Request(
        `${origin.origin}/channel-connector/oauth/connections/${encodeURIComponent(input.connectionId)}/${action}`,
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.accessToken}` },
          body: canonicalJson(body),
        },
      ),
    );
  }
  async function authority(input: CoordinatorInput) {
    return input.authority ? input.authority() : "absent";
  }
  function select(claim: ClaimedOperationReservation): ConnectorExecutor | undefined {
    return [...executors.values()].find((executor) =>
      claim.operations.every((operation) =>
        executor.accepts.some(
          ([kind, payload]) => kind === operation.operationKind && payload === operation.payload.kind,
        ),
      ),
    );
  }
  function outcome(
    members: readonly OperationAttempt[],
    kind: "abandoned" | "rejected" | "outcome-unknown",
  ): ExecutorResult {
    return {
      outcomes: members.map((member) => ({
        operationId: member.operationId,
        attemptId: member.attemptId,
        claimGeneration: member.claimGeneration,
        desiredStateSequence: member.desiredStateSequence,
        outcome:
          kind === "abandoned"
            ? { kind, reason: "claimant-cancelled" }
            : kind === "rejected"
              ? { kind, code: "validation" }
              : { kind },
      })),
    };
  }
  function receiptFor(member: OperationAttempt, result: ExecutorResult): ExecutorResult {
    return { ...result, outcomes: result.outcomes.filter((outcome) => outcome.operationId === member.operationId) };
  }
  async function admit(input: CoordinatorInput, claim: ClaimedOperationReservation, state: OperationJournal) {
    const existingReservation = state.reservations.find((row) => row.reservationId === claim.reservationId);
    if (existingReservation) throw new OperationProtocolError("incomplete-authority");
    const executor = select(claim);
    const incomingIds = new Set(claim.operations.map((operation) => operation.operationId));
    const previous = new Map(state.members.map((member) => [member.operationId, member]));
    // Inspect the entire claim before producing either store's replacement.
    for (const operation of claim.operations) {
      const old = previous.get(operation.operationId);
      if (
        old &&
        (old.payloadDigest !== operation.payloadDigest ||
          old.state === "acked" ||
          old.operationKind !== operation.operationKind ||
          old.desiredStateSequence !== operation.desiredStateSequence ||
          canonicalJson(old.payload) !== canonicalJson(operation.payload))
      )
        refuse();
      if (
        old &&
        (operation.claimGeneration < old.claimGeneration ||
          (operation.claimGeneration === old.claimGeneration && operation.attemptId !== old.attemptId))
      )
        refuse();
      if (old?.state === "reported") throw new OperationProtocolError("incomplete-authority");
    }
    const members = claim.operations.map((operation): OperationAttempt => {
      const old = previous.get(operation.operationId);
      const base: OperationAttempt = {
        schemaVersion: 1,
        connectionId: input.connectionId,
        revision: old ? nextRevision(old.revision) : 0,
        operationId: operation.operationId,
        attemptId: operation.attemptId,
        claimGeneration: operation.claimGeneration,
        desiredStateSequence: operation.desiredStateSequence,
        reservationId: claim.reservationId,
        leaseExpiresAt: claim.leaseExpiresAt,
        operationKind: operation.operationKind,
        payload: operation.payload,
        payloadDigest: operation.payloadDigest,
        state: old?.state === "dispatched" ? "outcome-unknown" : (old?.state ?? "prepared"),
        preparedAt: old?.preparedAt ?? instant(),
        ...(old?.dispatchedAt ? { dispatchedAt: old.dispatchedAt } : {}),
        ...(old?.state === "dispatched" || old?.state === "outcome-unknown"
          ? { unknownReason: "incomplete-rebind" }
          : {}),
      };
      if (!old?.receipt) return base;
      const prior = old.receipt.outcomes.find((result) => result.operationId === operation.operationId);
      if (!prior) throw new OperationProtocolError("incomplete-authority");
      // A bound run cannot inherit its predecessor's settlement identity.
      if (old.receipt.runSettlement) return { ...base, state: "outcome-unknown", unknownReason: "incomplete-rebind" };
      return {
        ...base,
        receipt: {
          outcomes: [
            {
              ...prior,
              attemptId: operation.attemptId,
              claimGeneration: operation.claimGeneration,
              desiredStateSequence: operation.desiredStateSequence,
            },
          ],
        },
      };
    });
    const reservations: OperationReservation[] = [];
    for (const old of state.reservations) {
      const retained = old.memberOperationIds.filter((id) => !incomingIds.has(id));
      if (retained.length === old.memberOperationIds.length) reservations.push(old);
      else if (retained.length) reservations.push(revise(old, { memberOperationIds: retained }));
    }
    reservations.push({
      schemaVersion: 1,
      connectionId: input.connectionId,
      revision: 0,
      reservationId: claim.reservationId,
      executorKey: executor?.key ?? "unsupported",
      reservedAt: claim.reservedAt,
      leaseExpiresAt: claim.leaseExpiresAt,
      memberOperationIds: members.map((member) => member.operationId).sort(),
      phase: members.every((member) => member.state === "prepared") ? "prepared" : "outcome-unknown",
    });
    return journal.change(input.connectionId, state, {
      members: [...state.members.filter((member) => !incomingIds.has(member.operationId)), ...members].sort((a, b) =>
        a.operationId < b.operationId ? -1 : 1,
      ),
      reservations: reservations.sort((a, b) => (a.reservationId < b.reservationId ? -1 : 1)),
    });
  }
  async function report(
    input: CoordinatorInput,
    state: OperationJournal,
    reservation: OperationReservation,
  ): Promise<CoordinatorResult> {
    if ((await authority(input)) === "absent") return { outcome: "unknown" };
    let response: Response;
    try {
      response = await request(input, "report", reservation.reportEnvelope!);
    } catch {
      await write(input, state, revise(reservation, { lastRefusal: "transport" }), []);
      return { outcome: "unknown" };
    }
    if (!response.ok || (await response.text()) !== "{}") {
      await write(
        input,
        state,
        revise(reservation, {
          lastRefusal: response.status === 401 || response.status === 403 ? "authorization" : "stale-fence",
        }),
        [],
      );
      return {
        outcome:
          response.status === 401
            ? "invalid-credential"
            : response.status === 403
              ? "authorization-refused"
              : "unknown",
      };
    }
    const exact = unit(state, reservation);
    await write(
      input,
      state,
      revise(reservation, { phase: "acked", ackedAt: instant() }),
      exact.members.map((member) => revise(member, { state: "acked" })),
    );
    return { outcome: "ok" };
  }
  async function envelope(
    input: CoordinatorInput,
    state: OperationJournal,
    reservation: OperationReservation,
    result: ExecutorResult,
  ) {
    const exact = unit(state, reservation);
    assertTotalResult(result, exact.members);
    const reportEnvelope: ConnectorReport = {
      reservationId: reservation.reservationId,
      ...result,
      outcomes: [...result.outcomes].sort((a, b) => (a.operationId < b.operationId ? -1 : 1)),
    };
    return write(
      input,
      state,
      revise(reservation, { phase: "reported", reportEnvelope, reportedAt: instant() }),
      exact.members.map((member) => revise(member, { state: "reported" })),
    );
  }
  async function process(
    input: CoordinatorInput,
    state: OperationJournal,
    reservation: OperationReservation,
  ): Promise<CoordinatorResult> {
    if (reservation.phase === "acked") return { outcome: "ok" };
    if (reservation.phase === "reported") return report(input, state, reservation);
    let exact = unit(state, reservation);
    const executor = executors.get(reservation.executorKey);
    if (executor?.unit !== "reservation" && ports.clock.now() >= Date.parse(reservation.leaseExpiresAt))
      return { outcome: "unknown" };
    if (exact.members.some((member) => member.state === "dispatched")) {
      state = await write(
        input,
        state,
        revise(reservation, { phase: "outcome-unknown" }),
        exact.members
          .filter((member) => member.state === "dispatched")
          .map((member) => revise(member, { state: "outcome-unknown", unknownReason: "interrupted" })),
      );
      reservation = state.reservations.find((row) => row.reservationId === reservation.reservationId)!;
      exact = unit(state, reservation);
    }
    if (exact.members.some((member) => member.state === "outcome-unknown")) {
      if ((await authority(input)) === "absent") return { outcome: "unknown" };
      const reconciled = await executor?.reconcileAmbiguous?.(exact);
      if (!reconciled) {
        if (executor?.unit !== "operation") return { outcome: "unknown" };
        const result: ExecutorResult = {
          outcomes: exact.members.map(
            (member) =>
              member.receipt?.outcomes.find((item) => item.operationId === member.operationId) ??
              outcome([member], member.state === "prepared" ? "abandoned" : "outcome-unknown").outcomes[0],
          ),
        };
        state = await envelope(input, state, reservation, result);
        return report(input, state, state.reservations.find((row) => row.reservationId === reservation.reservationId)!);
      }
      const result = parseExecutorResult(reconciled);
      assertTotalResult(result, exact.members);
      if (executor?.unit === "reservation" && !result.runSettlement) refuse();
      state = await write(
        input,
        state,
        revise(reservation, { phase: "receipt-captured" }),
        exact.members.map((member) =>
          revise(member, { state: "receipt-captured", receipt: receiptFor(member, result) }),
        ),
      );
      reservation = state.reservations.find((row) => row.reservationId === reservation.reservationId)!;
      exact = unit(state, reservation);
    }
    if (exact.members.every((member) => member.state === "receipt-captured")) {
      const results = exact.members.map((member) => member.receipt!);
      const settlements = results.map((result) => result.runSettlement).filter((value) => value !== undefined);
      if (settlements.some((value) => canonicalJson(value) !== canonicalJson(settlements[0]))) refuse();
      const result: ExecutorResult = {
        outcomes: exact.members.map(
          (member) => member.receipt!.outcomes.find((outcome) => outcome.operationId === member.operationId)!,
        ),
        ...(settlements[0] ? { runSettlement: settlements[0] } : {}),
      };
      if (executor?.unit === "reservation" && !result.runSettlement) refuse();
      state = await envelope(input, state, reservation, result);
      return report(input, state, state.reservations.find((row) => row.reservationId === reservation.reservationId)!);
    }
    if (!executor) {
      state = await envelope(input, state, reservation, {
        outcomes: exact.members.map(
          (member) => member.receipt?.outcomes[0] ?? outcome([member], "abandoned").outcomes[0],
        ),
      });
      await report(input, state, state.reservations.find((row) => row.reservationId === reservation.reservationId)!);
      return { outcome: "unsupported-operation" };
    }
    if (
      (await authority(input)) !== "paired-idle" ||
      input.reason === "unpair" ||
      ports.clock.now() + executor.dispatchDeadlineMs + 30000 >= Date.parse(reservation.leaseExpiresAt)
    ) {
      if (executor.unit === "reservation") return { outcome: "unknown" };
      state = await envelope(input, state, reservation, outcome(exact.members, "abandoned"));
      return report(input, state, state.reservations.find((row) => row.reservationId === reservation.reservationId)!);
    }
    const preparedMembers = exact.members.filter((member) => member.state === "prepared");
    if (executor.unit === "reservation" && preparedMembers.length !== exact.members.length)
      return { outcome: "unknown" };
    const prepared = await executor.prepare({ reservation, members: preparedMembers });
    if (!prepared.ready) {
      const result = parseExecutorResult(prepared.result);
      assertTotalResult(result, preparedMembers);
      if (
        result.outcomes.some(
          (outcome) => outcome.outcome.kind !== "rejected" || outcome.outcome.code !== "validation",
        ) ||
        (executor.unit === "reservation" && !result.runSettlement)
      )
        refuse();
      state = await envelope(input, state, reservation, {
        ...result,
        outcomes: [
          ...result.outcomes,
          ...exact.members
            .filter((member) => member.state === "receipt-captured")
            .map((member) => member.receipt!.outcomes[0]),
        ],
      });
      return report(input, state, state.reservations.find((row) => row.reservationId === reservation.reservationId)!);
    }
    const groups =
      executor.unit === "reservation"
        ? [exact.members]
        : exact.members.filter((member) => member.state === "prepared").map((member) => [member]);
    for (const members of groups) {
      if (
        (await authority(input)) !== "paired-idle" ||
        ports.clock.now() + executor.dispatchDeadlineMs + 30000 >= Date.parse(reservation.leaseExpiresAt)
      )
        return { outcome: "unknown" };
      state = await write(
        input,
        state,
        revise(reservation, { phase: "dispatched" }),
        members.map((member) => revise(member, { state: "dispatched", dispatchedAt: instant() })),
      );
      reservation = state.reservations.find((row) => row.reservationId === reservation.reservationId)!;
      const dispatched = unit(state, reservation).members.filter((member) =>
        members.some((original) => original.operationId === member.operationId),
      );
      if ((await authority(input)) !== "paired-idle") return { outcome: "unknown" };
      const signal = AbortSignal.timeout(executor.dispatchDeadlineMs);
      let result: ExecutorResult;
      try {
        result = parseExecutorResult(
          await Promise.race([
            executor.dispatchOnce({ reservation, members: dispatched }, signal),
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new OperationProtocolError("incomplete-authority")), {
                once: true,
              }),
            ),
          ]),
        );
        assertTotalResult(result, dispatched);
        if (executor.unit === "reservation" && !result.runSettlement) refuse();
        if (signal.aborted) throw new OperationProtocolError("incomplete-authority");
      } catch {
        await write(
          input,
          state,
          revise(reservation, { phase: "outcome-unknown" }),
          dispatched.map((member) =>
            revise(member, { state: "outcome-unknown", unknownReason: "unprovable-response" }),
          ),
        );
        return { outcome: "unknown" };
      }
      state = await write(
        input,
        state,
        revise(reservation, { phase: "receipt-captured" }),
        dispatched.map((member) => revise(member, { state: "receipt-captured", receipt: receiptFor(member, result) })),
      );
      reservation = state.reservations.find((row) => row.reservationId === reservation.reservationId)!;
    }
    return process(input, state, reservation);
  }
  async function coordinate(input: CoordinatorInput): Promise<CoordinatorResult> {
    try {
      identifier(input.connectionId);
      if (!input.accessToken || (await authority(input)) === "absent") return { outcome: "unknown" };
      let state = await journal.read(input.connectionId);
      for (const member of state.members)
        if ((await browserPayloadDigest(member.payload)) !== member.payloadDigest) refuse();
      const expired = state.reservations
        .filter((row) => row.phase === "acked" && ports.clock.now() >= Date.parse(row.ackedAt!) + 86400000)
        .slice(0, 32);
      if (expired.length) {
        const ids = new Set(expired.map((row) => row.reservationId));
        state = await journal.change(input.connectionId, state, {
          members: state.members.filter((row) => !ids.has(row.reservationId)),
          reservations: state.reservations.filter((row) => !ids.has(row.reservationId)),
        });
      }
      for (const pending of state.reservations.filter((row) => row.phase !== "acked")) {
        state = await journal.read(input.connectionId);
        const reservation = state.reservations.find((row) => row.reservationId === pending.reservationId);
        if (!reservation) return { outcome: "unknown" };
        const result = await process(input, state, reservation);
        if (result.outcome !== "ok" && result.outcome !== "unknown") return result;
      }
      let pollWindowSeconds: number | undefined;
      const seen = new Set<string>();
      for (let count = 0; count < 8; count++) {
        if (input.reason === "unpair" || (await authority(input)) !== "paired-idle") break;
        const response = await request(input, "claim", {});
        if (!response.ok)
          return {
            outcome:
              response.status === 401
                ? "invalid-credential"
                : response.status === 403
                  ? "authorization-refused"
                  : "unknown",
          };
        const body = record(await response.json(), ["reservation", "pollWindowSeconds"]);
        if (
          !Number.isSafeInteger(body.pollWindowSeconds) ||
          Number(body.pollWindowSeconds) < 1 ||
          Number(body.pollWindowSeconds) > 86400
        )
          refuse();
        pollWindowSeconds = Number(body.pollWindowSeconds);
        if (body.reservation === null) break;
        let claim: ClaimedOperationReservation;
        try {
          claim = await parseOperationClaim(body.reservation, input.connectionId);
        } catch {
          refuse();
        }
        if (seen.has(claim.reservationId)) break;
        seen.add(claim.reservationId);
        state = await journal.read(input.connectionId);
        state = await admit(input, claim, state);
        const result = await process(
          input,
          state,
          state.reservations.find((row) => row.reservationId === claim.reservationId)!,
        );
        if (result.outcome !== "ok") return result;
      }
      const remaining = await journal.read(input.connectionId);
      return {
        outcome: remaining.reservations.some((row) => row.phase !== "acked") ? "unknown" : "ok",
        ...(pollWindowSeconds === undefined ? {} : { pollWindowSeconds }),
      };
    } catch (error) {
      if (error instanceof RetentionError && error.code === "upgrade-required") return { outcome: "upgrade-required" };
      return {
        outcome:
          error instanceof OperationProtocolError
            ? error.code === "protocol-violation"
              ? "protocol-violation"
              : error.code === "upgrade-required"
                ? "upgrade-required"
                : "unknown"
            : "unknown",
      };
    }
  }
  return { coordinate };
}

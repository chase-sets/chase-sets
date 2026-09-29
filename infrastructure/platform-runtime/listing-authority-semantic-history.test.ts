import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { historyFixture, bindSingleResourceHistories } from "./listing-authority-history-test-support";
import { authorityEventHash, authorityJournalStreams, readAuthorityJournal } from "./listing-authority-journal";

// Executable field-to-case map: paths are selected from the real protocol schema.
// Each single and coordinated canonical+witness rewrite leaves an untouched witness.
const operationFields = [
  "schemaVersion",
  "operationId",
  "tenantId",
  "accountId",
  "actor.userId",
  "committingOwner",
  "kind",
  "requestId",
  "commandFingerprint",
  "command.enable",
  "listingId",
  "target.kind",
  "subject.inventoryItemId",
  "subject.catalogItemId",
  "subject.productId",
  "subject.selectedOptions",
  "subject.quantity",
  "subject.pair.amount",
  "subject.pair.currencyCode",
  "subject.allocationRevision",
  "subject.commitmentSourceId",
  "expectedListingRevision",
  "expectedTargetRevision",
  "expectedVisibilityRevision",
  "expectedPublicationRevision",
  "generation",
  "openingEventId",
  "prepareBefore",
  "participants.0.owner",
  "participants.0.purpose",
  "principal.tenantId",
  "principal.accountId",
  "principal.userId",
  "principal.kind",
  "principal.membershipId",
  "principal.validBefore",
  "principal.authentication.kind",
  "principal.authentication.keyId",
  "principal.authentication.revision",
  "principal.delegation.delegationId",
  "principal.delegation.revision",
  "principal.delegation.scopeCeiling",
];
const grantFields = [
  "reservationId",
  "participant.owner",
  "participant.purpose",
  "resources",
  "sourceRevisions.0.resourceId",
  "sourceRevisions.0.revision",
  "value.ready",
  "validBefore",
  "status",
  ...operationFields.map((field) => `operation.${field}`),
];
const fields = [
  ...operationFields.map((field) => ({
    kind: "operation" as const,
    suffix: ".opened",
    path: `payload.operation.${field}`,
    phase: "pending" as const,
  })),
  ...["result.accepted", "reason"].map((field) => ({
    kind: "operation" as const,
    suffix: ".committed",
    path: `payload.${field}`,
    phase: "committed" as const,
  })),
  ...["reservation", "resource"].flatMap((kind) =>
    grantFields.map((field) => ({
      kind: kind as "reservation" | "resource",
      suffix: ".reserved",
      path: `payload.reservation.${field}`,
      phase: "pending" as const,
    })),
  ),
  ...["mutationId", "command.inputs", "command.writeId"].map((field) => ({
    kind: "resource" as const,
    suffix: ".invalidation-started",
    path: `payload.invalidation.${field}`,
    phase: "pending" as const,
  })),
  ...["mutationId", "command.inputs", "command.writeId", "resources"].map((field) => ({
    kind: "mutation" as const,
    suffix: ".invalidation-started",
    path: `payload.intent.${field}`,
    phase: "pending" as const,
  })),
  ...[
    "writeId",
    "mutationId",
    "resources",
    "inputs.0.streamId",
    "inputs.0.expectedVersion",
    "inputs.0.context.tenantId",
    "inputs.0.context.audit.forAccountId",
    "inputs.0.context.audit.performedByUserId",
    "inputs.0.events.0.eventType",
    "inputs.0.events.0.payload.revoked",
  ].map((field) => ({
    kind: "write" as const,
    suffix: ".started",
    path: `payload.${field}`,
    phase: "pending" as const,
  })),
  { kind: "resource" as const, suffix: ".settled", path: "payload.reservationId", phase: "effective" as const },
  {
    kind: "resource" as const,
    suffix: ".invalidation-completed",
    path: "payload.mutationId",
    phase: "effective" as const,
  },
  { kind: "mutation" as const, suffix: ".invalidation-completed", path: "eventType", phase: "effective" as const },
  ...["status", "terminalEventId"].map((field) => ({
    kind: "reservation" as const,
    suffix: ".settled",
    path: `payload.${field}`,
    phase: "effective" as const,
  })),
  ...["status", "mutationId"].map((field) => ({
    kind: "write" as const,
    suffix: ".completed",
    path: `payload.${field}`,
    phase: "effective" as const,
  })),
];

function substitute(event: StoredEvent, path: string): StoredEvent {
  const copy = structuredClone(event);
  const parts = path.split(".");
  let node = copy as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    assert.ok(node[part] !== undefined, `schema parent ${part} exists for ${path}`);
    node = node[part] as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  assert.ok(key in node, `schema field exists: ${path}`);
  const prior = node[key];
  node[key] =
    typeof prior === "number"
      ? prior + 1
      : typeof prior === "boolean"
        ? !prior
        : Array.isArray(prior)
          ? []
          : "synthetic-substituted-value";
  if (JSON.stringify(node[key]) === JSON.stringify(prior)) node[key] = ["synthetic-false-member"];
  return copy;
}

async function prepared(phase: "pending" | "effective" | "committed") {
  const f = await historyFixture({ principal: true });
  const operation = await f.fence.open(f.input, f.context);
  const grant = await f.source.prepare(operation, f.context);
  const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
  const effects = ["business", "request-success"].map((kind) => ({
    streamId: `marketplace.synthetic-semantic-${kind}`,
    expectedVersion: 0 as const,
    context: f.context,
    events: [{ eventType: `synthetic.${kind}`, payload: { accepted: true } }],
  }));
  const before = new Set(f.sourceHistories.keys());
  if (phase === "committed") await f.consumerStore.appendToStreams!([...terminal, ...effects]);
  if (phase === "effective") await f.invalidate();
  else {
    f.blockInvalidation(true);
    await assert.rejects(f.invalidate());
    f.blockInvalidation(false);
  }
  return {
    f,
    operation,
    grant,
    terminal,
    effects,
    journals: bindSingleResourceHistories(f, operation, grant, before),
  };
}

async function safety(p: Awaited<ReturnType<typeof prepared>>, priorCommit: boolean) {
  const { f, operation, terminal, effects } = p;
  await f
    .restart()
    .invalidate()
    .catch(() => undefined);
  await f
    .restart()
    .source.settle(operation)
    .catch(() => undefined);
  const effective = (await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length;
  assert.ok(effective <= 1);
  const committed = await f.consumerStore.appendToStreams!([...terminal, ...effects]).then(
    () => true,
    () => false,
  );
  assert.equal(effective > 0 && committed, false);
  for (const effect of effects)
    assert.equal(
      (await f.consumerStore.readStream({ streamId: effect.streamId })).length,
      priorCommit || committed ? 1 : 0,
    );
}

describe("schema-aware canonical payload field map", () => {
  for (const field of fields)
    for (const paired of [null, 1, 2] as const)
      it(`${field.kind}/${field.phase}/${field.path}/canonical${paired ? `+${paired === 1 ? "integrity" : "registration"}-recomputed` : ""}`, async () => {
        const p = await prepared(field.phase);
        const store = field.kind === "operation" ? p.f.consumerStore : p.f.sourceStore;
        const histories = field.kind === "operation" ? p.f.consumerHistories : p.f.sourceHistories;
        const streams = authorityJournalStreams(p.journals[field.kind]);
        const canonical = histories.get(streams[0])!;
        const index = canonical.findIndex((event) => event.eventType.endsWith(field.suffix));
        assert.ok(index >= 0, `schema event ${field.suffix}`);
        const altered = substitute(canonical[index]!, field.path);
        histories.set(
          streams[0],
          canonical.map((event, at) => (at === index ? altered : event)),
        );
        if (paired)
          histories.set(
            streams[paired],
            histories.get(streams[paired])!.map((event, at) =>
              at === index
                ? {
                    ...event,
                    payload: { ...event.payload, eventId: altered.eventId, eventHash: authorityEventHash(altered) },
                  }
                : event,
            ),
          );
        await assert.rejects(readAuthorityJournal(store, streams[0]));
        await safety(p, field.phase === "committed");
      });
});

describe("witness fields and returned metadata contradictions", () => {
  for (const kind of ["operation", "reservation", "resource", "mutation", "write"] as const)
    for (const copies of [[0], [1], [2], [0, 1], [0, 2], [1, 2]])
      for (const path of [
        "eventType",
        "eventId",
        "streamId",
        "streamVersion",
        "tenantId",
        "forAccountId",
        "performedByUserId",
        "payload.eventId",
        "payload.eventHash",
        "payload.stateHash",
      ]) {
        if (
          path.startsWith("payload.") &&
          (copies.includes(0) || (path === "payload.stateHash" && kind !== "resource"))
        )
          continue;
        it(`${kind}/${copies.join("+")}/${path}/coordinated`, async () => {
          const p = await prepared("pending");
          const histories = kind === "operation" ? p.f.consumerHistories : p.f.sourceHistories;
          const streams = authorityJournalStreams(p.journals[kind]);
          for (const copy of copies)
            histories.set(
              streams[copy]!,
              histories.get(streams[copy]!)!.map((event) => substitute(event, path)),
            );
          // Own witness IDs are append-incarnation guards, not duplicate canonical IDs.
          // A pair of agreeing state hashes is rejected by the canonical resource fold.
          if (path !== "eventId" && path !== "payload.stateHash")
            await assert.rejects(
              readAuthorityJournal(kind === "operation" ? p.f.consumerStore : p.f.sourceStore, streams[0]),
            );
          await safety(p, false);
        });
      }
});

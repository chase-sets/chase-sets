import assert from "node:assert/strict";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityOperation, ListingAuthorityReservation } from "@chase-sets/event-core/listing-authority";
import type { ListingAuthorityFence, ListingAuthorityOperationInput } from "./listing-authority-fence";
import type { ListingAuthoritySource } from "./listing-authority-participant";

/** Each owner supplies its actual prepare/invalidate writer and reconstructs services on the same stores. */
export type ListingAuthorityConformanceFixture = Readonly<{
  context: EventStoreContext;
  input: ListingAuthorityOperationInput;
  consumerStore: EventStore;
  sourceStore: EventStore;
  fence: ListingAuthorityFence;
  source: ListingAuthoritySource;
  invalidate(): Promise<void>;
  restart(): ListingAuthorityConformanceFixture;
}>;

/** Domain proofs supplement, rather than substitute for, the storage protocol suite. */
export type ListingAuthorityOwnerProofs = Readonly<{
  auth: Readonly<{
    actualTokenAuthenticationAndSessionTokenRevisionBinding: () => Promise<void>;
    revokeSwitchExpireAndTokenMutationWriters: () => Promise<void>;
    tokenOnlyRotationAndSwitchAwayAndBack: () => Promise<void>;
    naturalSessionAndTokenExpiryFenceRetainedAppend: () => Promise<void>;
    closureRestartUnknownAndSqlMutationIdempotency: () => Promise<void>;
    ownerScopedSessionResourceAndIntegrityLoss: () => Promise<void>;
    routesInternalSeedAndDirectWriterCoverage: () => Promise<void>;
  }>;
  identity: Readonly<{
    removalSuspensionRoleKeyBadgeAndFounderWriters: () => Promise<void>;
    authenticatedUserAndStandingSystemAuthority: () => Promise<void>;
  }>;
  channels: Readonly<{
    disconnectAndConnectionIdentityWriters: () => Promise<void>;
    retainedAcceptanceWithoutProviderTransport: () => Promise<void>;
  }>;
  pricing: Readonly<{
    exactEvaluatedPairTargetAndDecisionBinding: () => Promise<void>;
    policyGoalAndStandingAuthorizationInvalidation: () => Promise<void>;
    dryRunHasNoReservationsOrEmission: () => Promise<void>;
  }>;
  inventory: Readonly<{
    newHoldAndAllocationPredicatePhantoms: () => Promise<void>;
    concurrentStockClaimsUseActualHolds: () => Promise<void>;
    inboundSaleAdmissionSurvivesConflictingReservation: () => Promise<void>;
  }>;
  catalog: Readonly<{
    newProfileAndSelectionPredicatePhantoms: () => Promise<void>;
    productAndMeasureWritersInvalidate: () => Promise<void>;
  }>;
  "commercial-terms": Readonly<{
    competingScheduleAndAgreementPredicatePhantoms: () => Promise<void>;
    effectiveTimeBoundaryAndIdentityFacts: () => Promise<void>;
  }>;
  marketplace: Readonly<{
    nativeEnableFeeVisibilityAndPublicationAtomicity: () => Promise<void>;
    nativeOffEditsWithoutFeeOrShippingParticipants: () => Promise<void>;
    twoIndependentTargetsAndBatchFailureScope: () => Promise<void>;
    staleCartOfferAndOrderingCommitmentsRejectWithoutCancelingPriorCommitments: () => Promise<void>;
    availabilityEvidencePolicyAndReviewScoringWritersInvalidate: () => Promise<void>;
  }>;
}>;

/** Auth source pass supplies actual Auth; the combined pass also supplies actual Identity.
 * Protocol fixtures are explicitly synthetic and cannot certify either owner pass.
 */
export type ListingAuthoritySessionConformanceFixture = ListingAuthorityConformanceFixture &
  Readonly<{
    prepareAuthorities(
      operation: ListingAuthorityOperation,
      context: EventStoreContext,
    ): Promise<readonly ListingAuthorityReservation[]>;
  }>;

export function listingAuthoritySessionConformance(
  test: (name: string, run: () => Promise<void>) => void,
  create: () => Promise<ListingAuthoritySessionConformanceFixture>,
) {
  async function prepared() {
    const f = await create();
    assert.notEqual(f.sourceStore, f.consumerStore);
    assert.equal(f.context.listingAuthorityPrincipal?.kind, "user");
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation, f.context);
    return { f, operation, grants };
  }
  function effects(f: ListingAuthoritySessionConformanceFixture, operation: ListingAuthorityOperation) {
    return ["business", "request-success"].map((kind) => ({
      streamId: `${operation.committingOwner}.synthetic-session-${kind}-${operation.operationId}`,
      expectedVersion: 0 as const,
      context: f.context,
      events: [{ eventType: `${operation.committingOwner}.synthetic-session-${kind}`, payload: { accepted: true } }],
    }));
  }
  test("session final operation cannot omit Auth even when Identity is present", async () => {
    const f = await create();
    await assert.rejects(
      f.fence.open({ ...f.input, participants: f.input.participants.filter((p) => p.owner !== "auth") }, f.context),
    );
  });
  test("session partial preparation cannot commit or release without a final terminal", async () => {
    const { f, operation, grants } = await prepared();
    await assert.rejects(
      f.fence.prepareCommit(
        operation,
        grants.filter((g) => g.participant.owner !== "auth"),
        {},
      ),
    );
    await assert.rejects(f.source.settle(operation));
    assert.equal((await f.source.inspect(operation))?.status, "reserved");
    await f.fence.abort(operation, "synthetic-partial-preparation");
    await f.fence.settle(operation);
    assert.equal((await f.source.inspect(operation))?.status, "released");
  });
  test("session revoke rejects a retained append and atomically leaves no business or request success", async () => {
    const { f, operation, grants } = await prepared();
    const terminal = await f.fence.prepareCommit(operation, grants, { accepted: true });
    const business = effects(f, operation);
    await f.invalidate();
    assert.equal((await f.restart().fence.inspect(operation)).status, "aborted");
    await assert.rejects(f.consumerStore.appendToStreams!([terminal, ...business]));
    for (const append of business)
      assert.equal((await f.consumerStore.readStream({ streamId: append.streamId })).length, 0);
    assert.equal((await f.fence.inspect(operation)).status, "aborted");
  });
  test("unchanged session commits once and commit-wins preserves business and request success", async () => {
    const { f, operation, grants } = await prepared();
    const terminal = await f.fence.prepareCommit(operation, grants, { accepted: true });
    const business = effects(f, operation);
    await f.consumerStore.appendToStreams!([terminal, ...business]);
    await f.invalidate();
    assert.equal((await f.restart().fence.inspect(operation)).status, "committed");
    for (const append of business)
      assert.equal((await f.consumerStore.readStream({ streamId: append.streamId })).length, 1);
    await assert.rejects(f.consumerStore.appendToStreams!([terminal, ...business]));
    await f.fence.settle(operation);
    assert.equal((await f.source.inspect(operation))?.status, "consumed");
    const later = await f.fence.open({ ...f.input, requestId: "synthetic-session-after-revoke" }, f.context);
    await assert.rejects(f.prepareAuthorities(later, f.context));
  });
  for (const field of ["revision", "tokenRevision"] as const)
    test(`session same-key recovery cannot upgrade ${field}`, async () => {
      const { f, operation } = await prepared();
      const principal = operation.principal;
      assert(principal?.kind === "user" && principal.authentication.kind === "session");
      const context = {
        ...f.context,
        listingAuthorityPrincipal: {
          ...principal,
          authentication: { ...principal.authentication, [field]: "synthetic-substituted-revision" },
        },
      };
      await assert.rejects(f.fence.open(f.input, context));
      await assert.rejects(f.source.prepare(operation, context));
      assert.deepEqual((await f.restart().source.inspect(operation))?.operation.principal, principal);
    });
}

export function listingAuthorityOwnerConformance<Owner extends keyof ListingAuthorityOwnerProofs>(
  test: (name: string, run: () => Promise<void>) => void,
  owner: Owner,
  proofs: ListingAuthorityOwnerProofs[Owner],
) {
  for (const [name, run] of Object.entries(proofs)) test(`${owner} authority: ${name}`, run);
}

export function listingAuthorityConformance(
  test: (name: string, run: () => Promise<void>) => void,
  create: () => Promise<ListingAuthorityConformanceFixture>,
) {
  async function prepared(fixture: ListingAuthorityConformanceFixture) {
    const operation = await fixture.fence.open(fixture.input, fixture.context);
    const reservation = await fixture.source.prepare(operation, fixture.context);
    return { operation, reservation };
  }
  async function commit(
    fixture: ListingAuthorityConformanceFixture,
    operation: ListingAuthorityOperation,
    reservations: Awaited<ReturnType<ListingAuthoritySource["prepare"]>>[],
  ) {
    const terminal = await fixture.fence.prepareCommit(operation, reservations, { accepted: true });
    await fixture.consumerStore.appendToStreams!([
      terminal,
      {
        streamId: `${operation.committingOwner}.synthetic-commitment-${operation.operationId}`,
        expectedVersion: 0,
        context: fixture.context,
        events: [{ eventType: `${operation.committingOwner}.synthetic-commitment`, payload: { accepted: true } }],
      },
    ]);
  }

  test("unchanged foreign authority commits without any local source mirror", async () => {
    const f = await create();
    assert.notEqual(f.consumerStore, f.sourceStore);
    const { operation, reservation } = await prepared(f);
    await commit(f, operation, [reservation]);
    assert.equal((await f.fence.inspect(operation)).status, "committed");
    await f.fence.settle(operation);
    assert.equal((await f.source.inspect(operation))?.status, "consumed");
  });
  test("revoke wins after prepare and permanently rejects a delayed old executor", async () => {
    const f = await create();
    const { operation, reservation } = await prepared(f);
    const terminal = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
    await f.invalidate();
    assert.equal((await f.fence.inspect(operation)).status, "aborted");
    await assert.rejects(f.consumerStore.appendToStreams!([terminal]));
    const restart = f.restart();
    await assert.rejects(commit(restart, operation, [reservation]));
    await restart.fence.settle(operation);
    assert.equal((await restart.source.inspect(operation))?.status, "released");
  });
  test("commit wins, preserves the prior commitment, and revocation rejects future work", async () => {
    const f = await create();
    const { operation, reservation } = await prepared(f);
    await commit(f, operation, [reservation]);
    await f.invalidate();
    assert.equal((await f.fence.inspect(operation)).status, "committed");
    const later = await f.fence.open({ ...f.input, requestId: "synthetic-later" }, f.context);
    await assert.rejects(f.source.prepare(later, f.context));
    await f.source.settle(operation);
    assert.equal((await f.source.inspect(operation))?.status, "consumed");
  });
  test("participant omission cannot commit and partial preparation releases only after durable abort", async () => {
    const f = await create();
    const { operation } = await prepared(f);
    await assert.rejects(f.fence.prepareCommit(operation, [], { accepted: true }));
    await assert.rejects(f.source.settle(operation));
    assert.equal((await f.source.inspect(operation))?.status, "reserved");
    await f.fence.abort(operation, "partial-preparation-failed");
    await f.fence.settle(operation);
    assert.equal((await f.source.inspect(operation))?.status, "released");
  });
  test("identical retries inspect the original operation and altered full-command retries conflict", async () => {
    const f = await create();
    const { operation, reservation } = await prepared(f);
    assert.deepEqual(await f.fence.open(f.input, f.context), operation);
    assert.deepEqual(await f.source.prepare(operation, f.context), reservation);
    await assert.rejects(f.fence.open({ ...f.input, command: { ...f.input.command, quantity: 2 } }, f.context));
    await assert.rejects(f.fence.open({ ...f.input, expectedListingRevision: 99 }, f.context));
  });
  const alterations: Readonly<Record<string, (operation: ListingAuthorityOperation) => ListingAuthorityOperation>> = {
    tenant: (operation) => ({ ...operation, tenantId: "tnt_wrong" }),
    account: (operation) => ({ ...operation, accountId: "acc_wrong" }),
    actor: (operation) => ({ ...operation, actor: { kind: "user", userId: "usr_wrong" } }),
    target: (operation) => ({ ...operation, target: { kind: "channel-connection", connectionId: "con_wrong" } }),
    pair: (operation) => ({ ...operation, command: { ...operation.command, priceCurrencyCode: "EUR" } }),
    quantity: (operation) => ({ ...operation, command: { ...operation.command, quantity: 99 } }),
    inventory: (operation) => ({ ...operation, subject: { ...operation.subject, inventoryItemId: "inv_wrong" } }),
    product: (operation) => ({ ...operation, subject: { ...operation.subject, productId: "cat_wrong::" } }),
    allocation: (operation) => ({ ...operation, subject: { ...operation.subject, allocationRevision: 99 } }),
    "commitment source": (operation) => ({
      ...operation,
      subject: { ...operation.subject, commitmentSourceId: "ord_wrong" },
    }),
    revision: (operation) => ({ ...operation, expectedListingRevision: operation.expectedListingRevision + 1 }),
    generation: (operation) => ({ ...operation, generation: operation.generation + 1 }),
  };
  for (const [name, alter] of Object.entries(alterations)) {
    test(`a reservation cannot authorize another ${name}`, async () => {
      const f = await create();
      const { operation, reservation } = await prepared(f);
      await assert.rejects(f.fence.prepareCommit(alter(operation), [reservation], { accepted: true }));
      assert.equal((await f.fence.inspect(operation)).status, "pending");
    });
  }
  test("restart before commit and before or after source acknowledgement retains one terminal result", async () => {
    const f = await create();
    const { operation, reservation } = await prepared(f);
    const restarted = f.restart();
    await commit(restarted, operation, [reservation]);
    assert.equal((await restarted.source.inspect(operation))?.status, "reserved");
    await f.restart().fence.settle(operation);
    await f.restart().fence.settle(operation);
    assert.equal((await f.restart().source.inspect(operation))?.status, "consumed");
    await assert.rejects(commit(f.restart(), operation, [reservation]));
  });
  test("two independent target operations cannot borrow each other's reservations or terminal results", async () => {
    const f = await create();
    const first = await prepared(f);
    const secondOperation = await f.fence.open(
      {
        ...f.input,
        requestId: "synthetic-second-target",
        target: { kind: "channel-connection", connectionId: "con_synthetic_second" },
      },
      f.context,
    );
    const second = await f.source.prepare(secondOperation, f.context);
    await assert.rejects(commit(f, secondOperation, [first.reservation]));
    await commit(f, secondOperation, [second]);
    await commit(f, first.operation, [first.reservation]);
    assert.equal((await f.fence.inspect(first.operation)).status, "committed");
    assert.equal((await f.fence.inspect(secondOperation)).status, "committed");
  });
  test("expiry requires terminal abort and never releases a live source promise on elapsed time alone", async () => {
    const f = await create();
    const { operation, reservation } = await prepared(f);
    const append = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
    await assert.rejects(
      f.consumerStore.appendToStreams!([{ ...append, authorizationDeadline: "2000-01-01T00:00:00.000Z" }]),
    );
    assert.equal((await f.source.inspect(operation))?.status, "reserved");
    await f.fence.abort(operation, "expired");
    await f.fence.settle(operation);
    await assert.rejects(f.consumerStore.appendToStreams!([append]));
  });
}

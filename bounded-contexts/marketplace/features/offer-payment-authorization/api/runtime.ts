import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { OfferPaymentAuthorizationChanged } from "@chase-sets/event-core/public-event-payloads";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  consentActivationGuardAppendInput,
  readConsentActivationAuthority,
} from "@chase-sets/platform-policy/consent-activation-authority";
import {
  createMarketplaceAttempt,
  hashMarketplaceRequest,
  MarketplaceAttemptError,
} from "../../mutation-recovery/api/attempt";
import { readMarketplaceRecoveryHistory } from "../../mutation-recovery/domain/history";
import { resolveOfferPaymentEnforcement } from "../../offer-payment-consent/api/enforcement";
import { OFFER_PAYMENT_CONSENT_POLICY_KEY } from "../../offer-payment-consent/domain/consent-text";
import {
  authorizationEvent,
  authorizationRecordSchema,
  authorizationRequestSchema,
  authorizationResultSchema,
  authorizationStream,
  type AuthorizationRecord,
  type AuthorizationRequest,
  type AuthorizationResult,
  type PaymentSource,
  type ValidatedPaymentSource,
} from "../domain/contracts";
import {
  decideAuthorization,
  evolveAuthorization,
  initialAuthorization,
  OfferPaymentAuthorizationError,
  type AuthorizationChange,
  type AuthorizationCommand,
} from "../domain/domain";
import { isEligibleInstrument, readBuyerInstruments } from "../integrations/payments/instrument-projection";
import { readAuthorizationProjection } from "../read-model/projection";

const isConflict = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
const stalePreview = () => new OfferPaymentAuthorizationError("stale_preview");
const inactiveConsent = () => new OfferPaymentAuthorizationError("offer_payment_consent_not_approved");

function resultFrom(record: AuthorizationRecord, version: number): AuthorizationResult {
  return {
    authorizationId: authorizationStream(record.buyerAccountId),
    version,
    ...record.snapshot,
    preview: record.preview
      ? {
          previewId: record.preview.previewId,
          source: record.preview.source,
          consentVersion: record.preview.consentVersion,
        }
      : null,
  };
}

function privateRecord(event: StoredEvent, accountId: string) {
  const record = authorizationRecordSchema.parse(event.payload);
  if (record.buyerAccountId !== accountId || event.forAccountId !== accountId)
    throw new Error("Authorization account mismatch.");
  return record;
}

function standing(record: AuthorizationRecord, streamVersion: number) {
  const payload: OfferPaymentAuthorizationChanged = {
    buyerAccountId: record.buyerAccountId,
    state: record.snapshot.state,
    available: record.snapshot.state === "active",
    streamVersion,
  };
  return { eventType: authorizationEvent.changed, payload };
}

export function createOfferPaymentAuthorization({
  eventStore,
  db,
  now = () => new Date(),
}: {
  eventStore: EventStore;
  db: PgQueryable;
  now?: () => Date;
}) {
  const authority = () =>
    resolveOfferPaymentEnforcement({
      read: () => readConsentActivationAuthority(eventStore, OFFER_PAYMENT_CONSENT_POLICY_KEY),
    });

  async function load(accountId: string) {
    const streamId = authorizationStream(accountId);
    const history = await readMarketplaceRecoveryHistory(
      eventStore,
      streamId,
      {
        version: 0,
        state: initialAuthorization,
        preview: undefined as AuthorizationRecord["preview"],
        operations: new Map<string, { hash: string; result: AuthorizationResult }>(),
        pendingStanding: undefined as ReturnType<typeof standing>["payload"] | undefined,
      },
      (current, event) => {
        if (current.pendingStanding) {
          if (
            event.eventType !== authorizationEvent.changed ||
            event.forAccountId !== accountId ||
            hashMarketplaceRequest(event.payload) !== hashMarketplaceRequest(current.pendingStanding)
          )
            throw new Error("Missing authorization standing fact.");
          return { ...current, version: event.streamVersion, pendingStanding: undefined };
        }
        const record = privateRecord(event, accountId);
        const preview = event.eventType === authorizationEvent.previewed;
        if (
          event.eventType === authorizationEvent.changed ||
          !Object.values(authorizationEvent).includes(event.eventType as never) ||
          preview !== Boolean(record.preview)
        )
          throw new Error("Invalid authorization fact.");
        const resultVersion = event.streamVersion + (preview ? 0 : 1);
        if (record.operation) {
          if (current.operations.has(record.operation.id)) throw new Error("Duplicate authorization operation.");
          current.operations.set(record.operation.id, {
            hash: record.operation.requestHash,
            result: resultFrom(record, resultVersion),
          });
        }
        return {
          ...current,
          version: event.streamVersion,
          preview: record.preview,
          state: preview
            ? current.state
            : evolveAuthorization(current.state, {
                type: event.eventType as AuthorizationChange["type"],
                snapshot: record.snapshot,
              }),
          pendingStanding: preview ? undefined : standing(record, resultVersion).payload,
        };
      },
    );
    if (!history.complete || history.state.pendingStanding)
      throw new MarketplaceAttemptError("history_incomplete", "Offer Payment Authorization history is incomplete.");
    return history.state;
  }

  async function validateSource(accountId: string, source: PaymentSource): Promise<ValidatedPaymentSource> {
    if (source.instrumentId === null && source.useBalance)
      return { useBalance: true, instrumentId: null, category: null };
    if (source.instrumentId !== null) {
      const [instrument] = await readBuyerInstruments(db, accountId, source.instrumentId);
      if (instrument && isEligibleInstrument(instrument, now()))
        return { ...source, instrumentId: source.instrumentId, category: instrument.category };
    }
    throw new OfferPaymentAuthorizationError("invalid_payment_source");
  }

  async function execute(input: AuthorizationRequest, context: EventStoreContext) {
    const { attemptId, ...command } = authorizationRequestSchema.parse(input);
    const buyerAccountId = context.audit.forAccountId;
    const streamId = authorizationStream(buyerAccountId);
    const attempt = createMarketplaceAttempt(
      eventStore,
      {
        attemptId,
        mutationKind: "offer-payment-authorization.command",
        accountId: buyerAccountId,
        target: { kind: "offer-payment-authorization", id: buyerAccountId },
        request: command,
      },
      authorizationResultSchema,
    );
    const existing = await attempt.read();
    if (existing) return existing;
    const requestHash = hashMarketplaceRequest(command);
    const replay = (current: Awaited<ReturnType<typeof load>>) => {
      const prior = current.operations.get(command.operationId);
      if (!prior) return null;
      if (prior.hash !== requestHash) throw new OfferPaymentAuthorizationError("operation_conflict");
      return attempt.commit([], prior.result, { id: streamId, version: prior.result.version }, context);
    };
    const current = await load(buyerAccountId);
    const prior = replay(current);
    if (prior) return prior;
    if (command.expectedVersion !== current.version) throw stalePreview();

    const operation = { id: command.operationId, requestHash };
    let record: AuthorizationRecord;
    let eventType: string;
    let guard: AppendToStreamInput | undefined;
    if (command.type === "preview") {
      const { version, snapshot } = await authority();
      if (!version) throw inactiveConsent();
      const source = await validateSource(buyerAccountId, command.source);
      guard = consentActivationGuardAppendInput(snapshot.guard, context);
      record = {
        buyerAccountId,
        operation,
        snapshot: current.state.snapshot,
        preview: {
          previewId: hashMarketplaceRequest([streamId, current.version, operation, version, snapshot.authorityVersion]),
          source,
          consentVersion: version,
          authorityVersion: snapshot.authorityVersion,
        },
      };
      eventType = authorizationEvent.previewed;
    } else {
      let decision: AuthorizationCommand;
      if (command.type === "authorize") {
        const { version, snapshot } = await authority();
        if (command.consent !== true) throw inactiveConsent();
        if (
          current.preview &&
          (current.preview.consentVersion !== snapshot.activeVersion ||
            current.preview.authorityVersion !== snapshot.authorityVersion)
        )
          throw stalePreview();
        if (!version) throw inactiveConsent();
        if (!current.preview || command.previewId !== current.preview.previewId) throw stalePreview();
        const source = await validateSource(buyerAccountId, current.preview.source);
        if (source.category !== current.preview.source.category) throw stalePreview();
        guard = consentActivationGuardAppendInput(snapshot.guard, context);
        decision = { type: "authorize", consentVersion: version, source };
      } else if (command.type === "resume") {
        decision = { type: "resume", source: await validateSource(buyerAccountId, command.source) };
      } else {
        decision = { type: "revoke" };
      }
      const change = decideAuthorization(current.state, decision)!;
      eventType = change.type;
      record = { buyerAccountId, operation, snapshot: change.snapshot };
    }
    const result = resultFrom(record, current.version + (record.preview ? 1 : 2));
    try {
      return await attempt.commit(
        [
          {
            streamId,
            expectedVersion: current.version || "no_stream",
            context,
            events: [{ eventType, payload: record }, ...(record.preview ? [] : [standing(record, result.version)])],
          },
          ...(guard ? [guard] : []),
        ],
        result,
        { id: streamId, version: result.version },
        context,
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
      // A competing exact operation may have won with a different attempt ID.
      const won = replay(await load(buyerAccountId));
      if (won) return won;
      throw stalePreview();
    }
  }

  async function system(
    context: EventStoreContext,
    choose: (
      current: Awaited<ReturnType<typeof load>>,
    ) => Promise<AuthorizationCommand | null> | AuthorizationCommand | null,
  ) {
    const buyerAccountId = context.audit.forAccountId;
    for (;;) {
      const current = await load(buyerAccountId);
      const command = await choose(current);
      const change = command && decideAuthorization(current.state, command);
      if (!change) return;
      const record = { buyerAccountId, snapshot: change.snapshot };
      try {
        const events = await eventStore.appendToStream({
          streamId: authorizationStream(buyerAccountId),
          expectedVersion: current.version || "no_stream",
          context,
          events: [{ eventType: change.type, payload: record }, standing(record, current.version + 2)],
        });
        recordCommittedEvents(events);
        return;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }

  async function read(accountId: string) {
    const [authorization, instruments, policy] = await Promise.all([
      readAuthorizationProjection(db, accountId),
      readBuyerInstruments(db, accountId),
      authority(),
    ]);
    const { source } = authorization;
    return {
      ...authorization,
      source: source && {
        ...source,
        displayLabel: instruments.find((item) => item.instrumentId === source.instrumentId)?.displayLabel ?? null,
      },
      eligibleInstruments: instruments
        .filter((item) => isEligibleInstrument(item, now()))
        .map(({ instrumentId, category, displayLabel }) => ({ instrumentId, category, displayLabel })),
      policyActivation: { version: policy.version },
    };
  }

  return {
    execute,
    read,
    markRequired: (context: EventStoreContext) => system(context, () => ({ type: "markRequired" })),
    markPaymentMethodUnavailable: (generation: number, instrumentId: string, context: EventStoreContext) =>
      system(context, () => ({ type: "markPaymentMethodUnavailable", generation, instrumentId })),
    holdForFailedPayment: (orderId: string, generation: number, context: EventStoreContext) =>
      system(context, () => ({ type: "holdForFailedPayment", orderId, generation })),
    reconcile: (context: EventStoreContext) =>
      system(context, async ({ state: { snapshot } }) => {
        const instrumentId = snapshot.source?.instrumentId;
        if (snapshot.state !== "active" || !instrumentId) return null;
        const [instrument] = await readBuyerInstruments(db, context.audit.forAccountId, instrumentId);
        return instrument &&
          isEligibleInstrument(instrument, now()) &&
          instrument.category === snapshot.source?.category
          ? null
          : { type: "markPaymentMethodUnavailable", generation: snapshot.generation, instrumentId };
      }),
  };
}

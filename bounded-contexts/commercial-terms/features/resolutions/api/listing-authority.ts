import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  ListingAuthorityConsumerPort,
  ListingAuthorityOperation,
  ListingAuthorityParticipantPort,
  ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { toJsonValue } from "@chase-sets/primitives/json";
import { initialPolicyDocumentState, decidePolicyDocument } from "@chase-sets/platform-policy/domain";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import { createListingAuthorityRecovery } from "@chase-sets/platform-runtime/listing-authority-recovery";
import {
  evolveCommercialTermsPolicyDocument,
  type CommercialTermsPolicyDocumentEvent,
} from "../../../support/runtime-support/policy-runtime";
import {
  commercialTermsAgreementPolicyKey,
  decodeCommercialTermsAgreementPolicyValue,
} from "../../../support/runtime-support/terms-policy";
import {
  MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY,
  decodeMarketplaceSalesFeeSchedulePolicyValue,
} from "../../marketplace-sales-fee/domain/policy";
import {
  selectListingTermsBasis,
  quoteFromListingTermsBasis,
  type CommercialTermsAccountFacts,
  type ActiveSchedule,
  type ActiveAgreement,
} from "../read-model/resolve";

export type CommercialTermsListingAuthorityPorts = Readonly<{
  consumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
  /** Bind Identity's exported participant and fact decoder, never projected account rows. */
  identity?: Readonly<{
    participant: ListingAuthorityParticipantPort;
    accountFacts(reservation: ListingAuthorityReservation): CommercialTermsAccountFacts;
  }>;
}>;

export function createCommercialTermsListingAuthority(
  deps: Readonly<{
    eventStore: EventStore;
    db: PgQueryable;
    now?: () => Date;
  }>,
  ports: CommercialTermsListingAuthorityPorts,
) {
  const { repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CommercialTermsPolicyDocumentEvent>(),
    initialState: () => initialPolicyDocumentState,
    evolve: evolveCommercialTermsPolicyDocument,
    decide: decidePolicyDocument,
  });
  const resources = (operation: ListingAuthorityOperation) => [
    `policy/${MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY}`,
    `policy/${commercialTermsAgreementPolicyKey(operation.accountId)}`,
  ];
  const source = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    participant: { owner: "commercial-terms", purpose: "native-fee" },
    resourceScope: "owner",
    consumer: ports.consumer,
    resources,
    validate: async (operation, context) => {
      if (!operation.subject.pair || operation.target.kind !== "native-marketplace")
        throw new Error("Native fee authority requires an exact native price pair.");
      const identity = ports.identity;
      if (
        !identity ||
        identity.participant.participant.owner !== "identity" ||
        identity.participant.participant.purpose !== "manage-listing"
      ) {
        throw new Error("Commercial Terms requires mounted Identity account/founder participation.");
      }
      const identityGrant = await identity.participant.prepare(operation, context);
      if (identityGrant.status !== "reserved") throw new Error("Identity account authority is no longer reserved.");
      const account = identity.accountFacts(identityGrant);
      const at = (deps.now?.() ?? new Date()).toISOString();
      const keys = [MARKETPLACE_SALES_FEE_SCHEDULE_POLICY_KEY, commercialTermsAgreementPolicyKey(operation.accountId)];
      const candidates = await currentPolicyStreams(deps.db, keys, operation.accountId, at);
      const documents = await Promise.all(
        candidates.map(async (streamId) => ({ streamId, ...(await repository.load(streamId)) })),
      );
      if (documents.some(({ state }) => !state.policyKey || !keys.includes(state.policyKey)))
        throw new Error("Commercial Terms selector returned a foreign policy.");
      const active = documents.filter(
        ({ state }) =>
          state.status === "active" &&
          state.effectiveFrom !== null &&
          Date.parse(state.effectiveFrom) <= Date.parse(at) &&
          (state.effectiveUntil === null || Date.parse(state.effectiveUntil) > Date.parse(at)),
      );
      const schedules = active.filter(({ state }) => state.policyKey === keys[0]);
      const agreements = active.filter(({ state }) => state.policyKey === keys[1]);
      if (schedules.length > 1 || agreements.length > 1)
        throw new Error("Overlapping active Commercial Terms policies.");
      let schedule: ActiveSchedule | null = null;
      let agreement: ActiveAgreement | null = null;
      if (schedules[0]) {
        const { state } = schedules[0];
        const value = decodeMarketplaceSalesFeeSchedulePolicyValue(state.value);
        schedule = {
          schedule_id: state.documentId!,
          label: value.label,
          marketplace_sales_fee_percentage_bps: value.marketplaceSalesFeePercentageBps,
          marketplace_sales_fee_fixed_amount: value.marketplaceSalesFeeFixedAmount,
          marketplace_sales_fee_cap_amount: value.marketplaceSalesFeeCapAmount,
          shipping_allowance_percentage_bps: value.shippingAllowancePercentageBps,
          updated_at: state.effectiveFrom!,
        };
      }
      if (agreements[0]) {
        const { state } = agreements[0];
        const value = decodeCommercialTermsAgreementPolicyValue(state.value);
        agreement = {
          agreement_id: state.documentId!,
          marketplace_sales_fee_percentage_bps: value.marketplaceSalesFeePercentageBps,
          marketplace_sales_fee_fixed_amount: value.marketplaceSalesFeeFixedAmount,
          shipping_allowance_percentage_bps: value.shippingAllowancePercentageBps,
        };
      }
      const basis = selectListingTermsBasis(account, schedule, agreement, operation.accountId, at);
      const boundaries = [
        operation.prepareBefore,
        identityGrant.validBefore,
        account.founders_window_started_at,
        account.founders_window_ends_at,
        ...documents.flatMap(({ state }) => [state.effectiveFrom, state.effectiveUntil]),
      ].filter((value): value is string => typeof value === "string" && Date.parse(value) > Date.parse(at));
      if (
        Date.parse(operation.prepareBefore) <= Date.parse(at) ||
        Date.parse(identityGrant.validBefore) <= Date.parse(at)
      )
        throw new Error("Commercial Terms authorization expired.");
      const validBefore = boundaries.reduce(
        (earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest),
        operation.prepareBefore,
      );
      return {
        value: {
          terms: toJsonValue(quoteFromListingTermsBasis(basis, operation.subject.pair.amount)),
          identityReservationId: identityGrant.reservationId,
        },
        validBefore,
        sourceRevisions: documents.map((document) => ({
          resourceId: document.streamId,
          revision: String(document.version),
        })),
        localAppends: documents.map((document) => ({
          streamId: document.streamId,
          expectedVersion: document.version,
          context,
          events: [],
        })),
      };
    },
  });
  const writer = createListingAuthorityWriter({
    eventStore: deps.eventStore,
    source,
    owner: "commercial-terms",
    resources: async (inputs) => {
      const affected = new Set<string>();
      for (const input of inputs) {
        if (!input.events.length) continue;
        const policyEvents = input.events.filter(
          (event) =>
            event.eventType.startsWith("platform-policy.document.") ||
            event.eventType.startsWith("commercial-terms.agreement.") ||
            event.eventType.startsWith("commercial-terms.schedule."),
        );
        if (!policyEvents.length) continue;
        const before = await repository.load(input.streamId);
        if (before.state.policyKey) affected.add(`policy/${before.state.policyKey}`);
        for (const event of policyEvents) {
          if (typeof event.payload.policyKey === "string") affected.add(`policy/${event.payload.policyKey}`);
          else if (typeof event.payload.accountId === "string")
            affected.add(`policy/${commercialTermsAgreementPolicyKey(event.payload.accountId)}`);
          else if (!before.state.policyKey && !event.eventType.startsWith("commercial-terms.schedule."))
            throw new Error("Unknown policy mutation authority.");
        }
      }
      return [...affected];
    },
  });
  return {
    source,
    ...writer,
    recover: createListingAuthorityRecovery({
      db: deps.db,
      owner: "commercial-terms",
      sources: [source],
      consumer: ports.consumer,
      resume: writer.resume,
      resumeWrite: writer.resumeWrite,
      now: deps.now,
    }),
  };
}

/** Query the owner's event history, not platform_policy_documents or a foreign projection. */
async function currentPolicyStreams(db: PgQueryable, keys: readonly string[], accountId: string, at: string) {
  const result = await db.query<{ stream_id: string }>(
    `
    WITH identities AS (
      SELECT DISTINCT stream_id,
        COALESCE(payload->>'policyKey', ($1::text[])[2]) AS policy_key
      FROM event_store_events
      WHERE (event_type = 'platform-policy.document.created' AND payload->>'policyKey' = ANY($1::text[]))
         OR (event_type = 'commercial-terms.agreement.created' AND payload->>'accountId' = $2)
    ), live AS (
      SELECT identities.*, latest.payload,
        (latest.payload->>'effectiveFrom')::timestamptz <= $3::timestamptz AS current
      FROM identities CROSS JOIN LATERAL (
        SELECT payload FROM event_store_events WHERE stream_id = identities.stream_id
        ORDER BY stream_version DESC LIMIT 1
      ) AS latest
      WHERE latest.payload->>'status' = 'active'
        AND ((latest.payload->>'effectiveUntil') IS NULL OR (latest.payload->>'effectiveUntil')::timestamptz > $3::timestamptz)
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY policy_key, current ORDER BY (payload->>'effectiveFrom')::timestamptz, stream_id) AS ordinal
      FROM live
    ) SELECT stream_id FROM ranked WHERE (current AND ordinal <= 2) OR (NOT current AND ordinal = 1)
    ORDER BY policy_key, stream_id`,
    [keys, accountId, at],
  );
  if (result.rows.length > 6) throw new Error("Commercial Terms current selector exceeded its bound.");
  return result.rows.map((row) => row.stream_id);
}

import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS } from "../../../../support/runtime-support/common";
import type { AgreementServices } from "../../api/runtime";

const ACCOUNT_STREAM_PREFIX = "identity.account-";

export function foundersWindowAgreementId(accountId: string) {
  return `cag_fnd_${accountId.replace(/^acc_/, "")}`;
}

export function buildFoundersWindowReactionHandlers(agreements: AgreementServices): ProjectorHandlerMap {
  return {
    "identity.account.founders-window-opened": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      const data = event.data as { betaAccessStartedAt: string; foundersWindowEndsAt: string };
      const context: EventStoreContext = {
        tenantId: event.tenantId,
        audit: event.audit,
        trace: event.trace,
      };
      await agreements.createAgreement(
        {
          agreementId: foundersWindowAgreementId(accountId),
          label: "Founders window",
          accountId,
          marketplaceSalesFeePercentageBps: 0,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
          status: "active",
          effectiveFrom: data.betaAccessStartedAt,
          effectiveUntil: data.foundersWindowEndsAt,
          createdByUserId: event.audit.performedByUserId,
        },
        context,
      );
    },
  };
}

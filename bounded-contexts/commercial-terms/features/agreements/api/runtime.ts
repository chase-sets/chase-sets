import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import { commercialTermsAgreementPolicy } from "../../../support/runtime-support/terms-policy";
import {
  CommercialTermsDomainError,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  type CommercialTermsStatus,
} from "../../../support/runtime-support/common";
import { getAgreement, getCommercialTermsAccountReference, listAgreements } from "../read-model/queries";
import { normalizeAgreementAccountIdText } from "./account-id";

/**
 * Agreements converged onto the shared platform-policy machinery:
 * this module no longer owns an aggregate, command handler, or projector --
 * those live once, shared across every commercial-terms policy family, in
 * `support/runtime-support/policy-runtime.ts`. What remains here is
 * agreement-specific: account-existence validation and translating the
 * admin-facing create/revise shape into a
 * `commercial-terms.agreement.<accountId>` policy document.
 */

type AgreementRuntimeDeps = Readonly<{
  policies: CommercialTermsPolicyRuntime;
  db: PgQueryable;
}>;

export type CreateAgreementParams = Readonly<{
  agreementId?: string;
  label: string;
  accountId: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps?: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  createdByUserId: string;
}>;

export type ReviseAgreementParams = Readonly<{
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  revisedByUserId: string;
}>;

export type AgreementServices = Readonly<{
  createAgreement: (
    params: CreateAgreementParams,
    context: EventStoreContext,
  ) => Promise<{ agreementId: string; version: number }>;
  reviseAgreement: (
    agreementId: string,
    params: ReviseAgreementParams,
    context: EventStoreContext,
  ) => Promise<{ agreementId: string; version: number }>;
  listAgreements: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listAgreements>;
  getAgreement: (agreementId: string) => ReturnType<typeof getAgreement>;
}>;

export function createAgreementRuntime(deps: AgreementRuntimeDeps): AgreementServices {
  async function assertAccountExists(accountId: string) {
    const account = await getCommercialTermsAccountReference(deps.db, accountId);
    if (!account) {
      throw new CommercialTermsDomainError(`Account ${accountId} is not available for commercial terms.`);
    }
  }

  return {
    async createAgreement(params, context) {
      const accountId = normalizeAgreementAccountIdText(params.accountId);
      await assertAccountExists(accountId);
      const definition = commercialTermsAgreementPolicy(accountId);
      return deps.policies.createAgreementDocument(
        definition,
        {
          ...(params.agreementId ? { documentId: params.agreementId } : {}),
          value: {
            label: params.label,
            accountId,
            marketplaceSalesFeePercentageBps: params.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: params.marketplaceSalesFeeFixedAmount,
            shippingAllowancePercentageBps:
              params.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
          },
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          actorUserId: params.createdByUserId,
        },
        context,
      );
    },
    async reviseAgreement(agreementId, params, context) {
      const current = await getAgreement(deps.db, agreementId);
      if (!current) {
        throw new CommercialTermsDomainError("Agreement not found.");
      }
      await assertAccountExists(current.account_id);
      const definition = commercialTermsAgreementPolicy(current.account_id);
      return deps.policies.reviseAgreementDocument(
        definition,
        agreementId,
        {
          value: {
            label: params.label,
            accountId: current.account_id,
            marketplaceSalesFeePercentageBps: params.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: params.marketplaceSalesFeeFixedAmount,
            shippingAllowancePercentageBps: params.shippingAllowancePercentageBps,
          },
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          actorUserId: params.revisedByUserId,
        },
        context,
      );
    },
    listAgreements: (params) => listAgreements(deps.db, params),
    getAgreement: (agreementId) => getAgreement(deps.db, agreementId),
  };
}

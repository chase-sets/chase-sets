import { t } from "@chase-sets/localization";
import { useFetcher } from "react-router";
import { AlertDialog, MarketplaceNotice, Stack, Text } from "@chase-sets/design-system";
import type {
  SubmittedOfferLifecycleAction,
  SubmittedOfferLifecycleOutcome,
  SubmittedOfferStatus,
  SubmittedOfferStatusFilter,
} from "./contracts";

export const SUBMITTED_OFFER_LIFECYCLE_INTENT = "offer-lifecycle";
export const submittedOfferLifecycleActionValues = ["pause", "resume", "withdraw"] as const;
export const submittedOfferStatusFilters = ["all", "submitted", "paused", "withdrawn", "accepted"] as const;

export function parseSubmittedOfferStatusFilter(value: string | null): SubmittedOfferStatusFilter {
  return submittedOfferStatusFilters.find((filter) => filter === value) ?? "all";
}

export type SubmittedOfferLifecycleControls = Readonly<{
  pending: boolean;
  outcomes: readonly SubmittedOfferLifecycleOutcome[] | null;
  onAction: (action: SubmittedOfferLifecycleAction, offerIds: readonly string[]) => void;
}>;

const lifecycleStatuses: readonly string[] = ["submitted", "paused", "withdrawn", "accepted"];
const rejectionCodes = ["not_found", "offer_transition_rejected", "offer_conflict", "offer_lifecycle_closed"] as const;
const isRejectionCode = (code: string): code is (typeof rejectionCodes)[number] =>
  (rejectionCodes as readonly string[]).includes(code);

/** Posts Pause/Resume/Withdraw to the current Submitted Offer route action; the reply is per-row outcomes. */
export function useSubmittedOfferLifecycle(): SubmittedOfferLifecycleControls {
  const fetcher = useFetcher<{ lifecycle?: { outcomes: SubmittedOfferLifecycleOutcome[] } }>();
  return {
    pending: fetcher.state !== "idle",
    outcomes: fetcher.data?.lifecycle?.outcomes ?? null,
    onAction: (action, offerIds) => {
      const form = new FormData();
      form.set("intent", SUBMITTED_OFFER_LIFECYCLE_INTENT);
      form.set("lifecycleAction", action);
      for (const offerId of offerIds) form.append("offerId", offerId);
      void fetcher.submit(form, { method: "post" });
    },
  };
}

export function submittedOfferStatusLabel(status: string) {
  return lifecycleStatuses.includes(status)
    ? t(`marketplace.features.offers.ui.submittedOfferLifecycle.status.${status as SubmittedOfferStatus}`)
    : status;
}

export function submittedOfferStatusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    case "paused":
      return "warning";
    default:
      return "neutral";
  }
}

/** Buyer actions a status admits; withdrawn and accepted Offers are final. */
export function submittedOfferLifecycleActions(status: string): readonly SubmittedOfferLifecycleAction[] {
  if (status === "submitted") return ["pause", "withdraw"];
  if (status === "paused") return ["resume", "withdraw"];
  return [];
}

/**
 * The command result is authoritative for its own Offer until the projected
 * read reaches the same stream version.
 */
export function latestSubmittedOfferStatus(
  offer: Readonly<{ offer_id: string; status: string; last_stream_version: number }>,
  outcomes: readonly SubmittedOfferLifecycleOutcome[] | null,
) {
  const outcome = outcomes?.find((candidate) => candidate.offerId === offer.offer_id);
  return outcome && outcome.outcome !== "rejected" && outcome.version > offer.last_stream_version
    ? outcome.status
    : offer.status;
}

export function SubmittedOfferLifecycleOutcomes({
  outcomes,
  titles,
}: {
  outcomes: readonly SubmittedOfferLifecycleOutcome[] | null;
  titles: ReadonlyMap<string, string>;
}) {
  if (!outcomes || outcomes.length === 0) return null;
  const count = (kind: SubmittedOfferLifecycleOutcome["outcome"]) =>
    outcomes.filter((outcome) => outcome.outcome === kind).length;
  const rejected = count("rejected");
  return (
    <MarketplaceNotice
      tone={rejected > 0 ? "warning" : "success"}
      title={t("marketplace.features.offers.ui.submittedOfferLifecycle.outcomes.title")}
      description={
        <Stack gap={1}>
          <Text size="sm">
            {t("marketplace.features.offers.ui.submittedOfferLifecycle.outcomes.summary", {
              changed: count("changed"),
              unchanged: count("unchanged"),
              rejected,
            })}
          </Text>
          {outcomes.map((outcome, index) => {
            const offer = titles.get(outcome.offerId) ?? outcome.offerId;
            return (
              <Text key={`${outcome.offerId}:${index}`} size="sm" tone="secondary" wrap="anywhere">
                {outcome.outcome === "rejected"
                  ? t(
                      `marketplace.features.offers.ui.submittedOfferLifecycle.outcome.${
                        isRejectionCode(outcome.code) ? outcome.code : "request_failed"
                      }`,
                      { offer },
                    )
                  : t(`marketplace.features.offers.ui.submittedOfferLifecycle.outcome.${outcome.outcome}`, {
                      offer,
                      status: submittedOfferStatusLabel(outcome.status),
                    })}
              </Text>
            );
          })}
        </Stack>
      }
    />
  );
}

export function WithdrawOfferConfirmation({
  offerIds,
  onCancel,
  onConfirm,
}: {
  offerIds: readonly string[] | null;
  onCancel: () => void;
  onConfirm: (offerIds: readonly string[]) => void;
}) {
  return (
    <AlertDialog
      open={offerIds !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      tone="warning"
      title={
        offerIds && offerIds.length > 1
          ? t("marketplace.features.offers.ui.submittedOfferLifecycle.withdraw.confirm.title.many", {
              count: offerIds.length,
            })
          : t("marketplace.features.offers.ui.submittedOfferLifecycle.withdraw.confirm.title.one")
      }
      description={t("marketplace.features.offers.ui.submittedOfferLifecycle.withdraw.confirm.description")}
      confirmLabel={t("marketplace.features.offers.ui.submittedOfferLifecycle.withdraw")}
      cancelLabel={t("marketplace.features.offers.ui.submittedOfferLifecycle.withdraw.confirm.cancel")}
      onConfirm={() => {
        if (offerIds) onConfirm(offerIds);
      }}
    />
  );
}

import { t } from "@chase-sets/localization";
import { evidenceCoverageCodeLocaleKey } from "../../../support/request-support/marketplace-listing-evidence";
import type { SellListLineScreenReview } from "../read-model/screen-review";
import type { LineReadiness } from "./sell-list-page-types";

const labelKeys = {
  ready: "checkout.features.sellList.ui.sellListPage.ready",
  "needs-refresh": "checkout.features.sellList.ui.sellListPage.needs.refresh",
  "needs-action": "checkout.features.sellList.ui.sellListPage.needs.action",
  "evidence-needs-action": "checkout.features.sellList.ui.sellListPage.evidence.needs.action",
} as const;

const detailKeys = {
  "public-standard-preview-ready": "checkout.features.sellList.ui.sellListPage.public.standard.offer.preview.ready.detail",
  "selected-offer-ready": "checkout.features.sellList.ui.sellListPage.selected.offer.ready.detail",
  "offer-terms-need-refresh": "checkout.features.sellList.ui.sellListPage.offer.terms.need.refresh",
  "evidence-unavailable": "checkout.features.sellList.ui.sellListPage.evidence.unavailable",
  "smart-match-ready": "checkout.features.sellList.ui.sellListPage.smart.match.ready.detail",
  "fallback-listing-ready": "checkout.features.sellList.ui.sellListPage.fallback.listing.ready.detail",
  "fallback-listing-form-ready": "checkout.features.sellList.ui.sellListPage.fallback.listing.form.ready.detail",
  "choose-sale-action": "checkout.features.sellList.ui.sellListPage.choose.sale.action.before.checkout",
} as const;

export function formatLineReadiness(answer: SellListLineScreenReview): LineReadiness {
  return {
    ready: answer.ready,
    label: t(labelKeys[answer.labelCode]),
    detail: answer.message ?? (answer.detailCode === "evidence-incomplete"
      ? answer.unmetEvidenceCodes.map((code) => t(evidenceCoverageCodeLocaleKey(code))).join(" ")
      : t(detailKeys[answer.detailCode], answer.parameters)),
    tone: answer.ready ? "success" : "warning",
  };
}

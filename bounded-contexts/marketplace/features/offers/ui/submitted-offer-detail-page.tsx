import { formatDateTime, formatMoney, t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { BuyerOfferPolicySnapshot } from "../../../client";
import type { BuyerOfferPolicyRequest, BuyerOfferPolicyTerms } from "../../offer-policy/domain/contracts";
import {
  AccountReputationSummary,
  Button,
  Checkbox,
  Form,
  ProgressiveDisclosure,
  Switch,
  TextInput,
  Badge,
  OrderProtectionModule,
  LinkButton,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  OfferCard,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  Stack,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { SubmittedOfferDetail } from "./contracts";

type MarketFollowingSubmittedOffer = SubmittedOfferDetail & { authoritativeOfferVersion?: number };

function statusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    default:
      return "neutral";
  }
}

export function MarketplaceSubmittedOfferDetailPage({
  offer,
  errorMessage,
  policies,
}: {
  offer: MarketFollowingSubmittedOffer;
  errorMessage?: string | null;
  policies?: readonly BuyerOfferPolicySnapshot[];
}) {
  const showAcceptedSellerReputation = offer.accepted_seller_account_id !== null && offer.status === "accepted";

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.submittedOfferDetailPage.offers")}
        title={offer.item_title}
        description={t("marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted")}
        actions={
          <LinkButton href="/account/offers/submitted" tone="secondary">
            {t("marketplace.features.offers.ui.submittedOfferDetailPage.back.to.submitted.offers")}
          </LinkButton>
        }
      />

      {policies ? <MarketFollowingOfferControls offers={[offer]} policies={policies} /> : null}

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview")}>
        <Stack gap={4}>
          <OfferCard
            title={offer.item_title}
            amount={
              offer.price_currency_code
                ? formatMoney(offer.price_amount, offer.price_currency_code)
                : t("marketplace.features.offers.ui.price.incomplete")
            }
            status={<Badge tone={statusTone(offer.status)}>{offer.status}</Badge>}
            details={
              <Stack gap={2}>
                {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
                {offer.product_summary ? (
                  <ProductOptions options={productOptionsFromSummary(offer.product_summary)} variant="chips" />
                ) : null}
                <Text>
                  {t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested")}
                  {offer.quantity_requested}
                </Text>
                <Text>
                  {t(
                    "marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide",
                  )}
                </Text>
                {showAcceptedSellerReputation ? (
                  <AccountReputationSummary
                    accountName={offer.accepted_seller_account_id}
                    averageRating={offer.accepted_seller_average_rating}
                    reviewCount={offer.accepted_seller_review_count ?? 0}
                    ratingLabel={t("marketplace.features.offers.ui.submittedOfferDetailPage.seller.reputation")}
                  />
                ) : null}
              </Stack>
            }
          />

          <PriceBreakdown
            lines={[
              {
                label: t("marketplace.features.offers.ui.submittedOfferDetailPage.offer.price"),
                value: offer.price_currency_code
                  ? formatMoney(offer.price_amount, offer.price_currency_code)
                  : t("marketplace.features.offers.ui.price.incomplete"),
              },
              {
                label: t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested"),
                value: offer.quantity_requested,
              },
            ]}
            total={
              offer.price_currency_code
                ? formatMoney(offer.price_amount, offer.price_currency_code)
                : t("marketplace.features.offers.ui.price.incomplete")
            }
            totalLabel={t("marketplace.features.offers.ui.submittedOfferDetailPage.offer.price")}
          />

          <OrderProtectionModule
            title={t("marketplace.features.offers.ui.submittedOfferDetailPage.offers")}
            items={[
              {
                title: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide",
                ),
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted",
                ),
              },
              {
                title: t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested"),
                description: String(offer.quantity_requested),
              },
              {
                title: t("marketplace.features.offers.ui.submittedOfferDetailPage.back.to.submitted.offers"),
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted",
                ),
              },
            ]}
          />

          <MarketplaceStatusTimeline
            steps={[
              {
                label: offer.status,
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide",
                ),
                status: offer.status === "submitted" ? "current" : "complete",
              },
              {
                label: t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview"),
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted",
                ),
                status: "upcoming",
              },
            ]}
          />
        </Stack>
      </PageSection>
    </Page>
  );
}

export function MarketFollowingOfferControls({
  offers,
  policies,
}: {
  offers: readonly MarketFollowingSubmittedOffer[];
  policies: readonly BuyerOfferPolicySnapshot[];
}) {
  const fetcher = useFetcher<{ policy: BuyerOfferPolicySnapshot | null; error: string | null }>();
  const [policy, setPolicy] = useState<BuyerOfferPolicySnapshot | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<string[]>(
    offers.length === 1 && offers[0]?.status === "submitted" ? [offers[0].offer_id] : [],
  );
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [allowance, setAllowance] = useState("");
  const [adjustment, setAdjustment] = useState("0");
  const [review, setReview] = useState(false);
  const [consent, setConsent] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(false);
  const draftId = useRef<string | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const pending = fetcher.state !== "idle";
  const selectedOffers = offers.filter((offer) => selected.includes(offer.offer_id) && offer.status === "submitted");
  const currency = selectedOffers[0]?.price_currency_code ?? policy?.currency;
  const bound = new Set(policies.flatMap((item) => (item.authority?.offers ?? []).map((offer) => offer.offerId)));
  const editable = policy?.status !== "stopped" && selectedOffers.length > 0;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    attempt.current = false;
    setConsent(false);
    setConfirmStop(false);
    setError(fetcher.data.error);
    if (fetcher.data.error) {
      if (fetcher.data.policy) setPolicy(fetcher.data.policy);
      setReview(false);
    } else if (fetcher.data.policy) {
      const next = fetcher.data.policy;
      setPolicy(next);
      setEnabled(true);
      setReview(Boolean(next.preview?.outcomes));
      const terms = next.preview?.terms ?? next.authority;
      if (terms) {
        setSelected(terms.offers.map((offer) => offer.offerId));
        setCaps(Object.fromEntries(terms.offers.map((offer) => [offer.offerId, offer.maximumUnitItemAmount])));
        setAllowance(terms.itemCommitmentAllowance);
        setAdjustment(String(terms.adjustmentBps / 100));
      }
    }
    feedback.current?.focus();
  }, [fetcher.data, fetcher.state]);

  function edit() {
    setReview(false);
    setConsent(false);
    setError(null);
  }
  function send(command: BuyerOfferPolicyRequest, policyId: string) {
    if (attempt.current || pending) return;
    attempt.current = true;
    setError(null);
    void fetcher.submit(
      { policyId, command: JSON.stringify(command), confirmStop: String(confirmStop) },
      { method: "post" },
    );
  }
  function preview() {
    if (!enabled || !currency || !editable) return;
    const offerVersions = Object.fromEntries(
      selectedOffers.map((offer) => [
        offer.offer_id,
        Math.max(policy?.offerVersions?.[offer.offer_id] ?? 0, offer.authoritativeOfferVersion ?? 0),
      ]),
    );
    if (selectedOffers.some((offer) => !offerVersions[offer.offer_id])) {
      setError("stale_preview");
      setReview(false);
      setConsent(false);
      feedback.current?.focus();
      return;
    }
    const percent = /^(-?)(\d{1,2})(?:\.(\d{1,2}))?$/.exec(adjustment);
    const bps = percent
      ? (Number(percent[2]) * 100 + Number((percent[3] ?? "").padEnd(2, "0"))) * (percent[1] ? -1 : 1)
      : NaN;
    const canonical = (value: string) => (/^\d+(\.\d{1,2})?$/.test(value) ? Number(value).toFixed(2) : value);
    if (
      !Number.isInteger(bps) ||
      bps < -2500 ||
      bps > 0 ||
      !allowance ||
      selectedOffers.some((offer) => offer.price_currency_code !== currency)
    ) {
      setError("invalid_authority");
      feedback.current?.focus();
      return;
    }
    const terms: BuyerOfferPolicyTerms = {
      currency,
      adjustmentBps: bps,
      itemCommitmentAllowance: canonical(allowance),
      offers: selectedOffers.map((offer) => ({
        offerId: offer.offer_id,
        offerVersion: offerVersions[offer.offer_id]!,
        catalogItemId: offer.catalog_catalog_item_id,
        productId: offer.product_id,
        selectedOptions: [...offer.selected_options],
        quantity: offer.quantity_requested,
        maximumUnitItemAmount: canonical(caps[offer.offer_id] ?? offer.price_amount),
      })),
    };
    const policyId = policy?.policyId ?? (draftId.current ??= `bop_${crypto.randomUUID()}`);
    send(
      {
        type: "PreviewBuyerOfferPolicy",
        operationId: crypto.randomUUID(),
        expectedVersion: policy?.version ?? 0,
        terms,
      },
      policyId,
    );
  }
  function manage(type: "PauseBuyerOfferPolicy" | "StopBuyerOfferPolicy" | "AuthorizeBuyerOfferPolicy") {
    if (!policy?.policyId) return;
    const operation = { operationId: crypto.randomUUID(), expectedVersion: policy.version };
    if (type === "AuthorizeBuyerOfferPolicy") {
      if (!review || !consent || !policy.preview) return;
      send({ ...operation, type, previewId: policy.preview.previewId, consent: true }, policy.policyId);
    } else send({ ...operation, type }, policy.policyId);
  }
  const errorCopy = error
    ? t(error === "stale_preview" ? "marketplace.marketFollowing.stale" : "marketplace.marketFollowing.error")
    : undefined;
  const reviewTerms = policy?.preview?.terms;
  return (
    <PageSection title={t("marketplace.marketFollowing.title")}>
      <Stack gap={4}>
        <Stack ref={feedback} tabIndex={-1} role="status">
          {errorCopy ? (
            <MarketplaceNotice
              tone="danger"
              title={t("marketplace.marketFollowing.errorTitle")}
              description={errorCopy}
            />
          ) : null}
          <Badge>{t(`marketplace.marketFollowing.status.${policy?.status ?? "draft"}`)}</Badge>
          {pending ? <Text>{t("marketplace.marketFollowing.pending")}</Text> : null}
        </Stack>
        <MarketplaceNotice
          tone="info"
          title={t("marketplace.marketFollowing.itemOnly")}
          description={t("marketplace.marketFollowing.effects")}
        />
        {policies
          .filter((item) => item.policyId)
          .map((item) => (
            <Button
              key={item.policyId}
              tone="secondary"
              disabled={pending}
              onClick={() => {
                if (attempt.current) return;
                attempt.current = true;
                void fetcher.submit({ intent: "load-policy", policyId: item.policyId! }, { method: "post" });
              }}
            >
              <Text element="span" wrap="anywhere">
                {t("marketplace.marketFollowing.manage", {
                  status: t(`marketplace.marketFollowing.status.${item.status}`),
                  offers: (item.authority?.offers ?? item.preview?.terms.offers ?? [])
                    .map((offer) => offer.offerId)
                    .join(", "),
                })}
              </Text>
            </Button>
          ))}
        {policy?.authority ? (
          <Stack gap={2}>
            <Text>
              {t("marketplace.marketFollowing.allowanceValue", {
                amount: formatMoney(policy.authority.itemCommitmentAllowance, policy.authority.currency),
              })}
            </Text>
            <Text>
              {t("marketplace.marketFollowing.consumed", {
                amount: formatMoney(policy.consumedItemAmount, policy.authority.currency),
              })}
            </Text>
            <Text>
              {t("marketplace.marketFollowing.remaining", {
                amount: formatMoney(policy.remainingItemAllowance ?? "0.00", policy.authority.currency),
              })}
            </Text>
            {policy.authority.offers.map((offer) => (
              <Text key={offer.offerId} wrap="anywhere">
                {t("marketplace.marketFollowing.selection", {
                  offer: offer.offerId,
                  product: offer.productId,
                  quantity: offer.quantity,
                  amount: formatMoney(offer.maximumUnitItemAmount, policy.authority!.currency),
                })}
              </Text>
            ))}
          </Stack>
        ) : null}
        {policy?.status === "stopped" ? (
          <MarketplaceNotice
            title={t("marketplace.marketFollowing.status.stopped")}
            description={t("marketplace.marketFollowing.stopEffects")}
          />
        ) : (
          <>
            <Switch
              label={t("marketplace.marketFollowing.toggle")}
              checked={enabled}
              disabled={pending || policy?.status === "active" || !offers.some((offer) => offer.status === "submitted")}
              onCheckedChange={(value) => {
                setEnabled(value);
                edit();
              }}
            />
            {enabled && offers.some((offer) => offer.status === "submitted") ? (
              <Form
                onSubmit={(event) => {
                  event.preventDefault();
                  preview();
                }}
                submitting={pending}
              >
                {offers
                  .filter(
                    (offer) =>
                      offer.status === "submitted" &&
                      (!bound.has(offer.offer_id) ||
                        policy?.authority?.offers.some((selection) => selection.offerId === offer.offer_id)),
                  )
                  .map((offer) => (
                    <Stack key={offer.offer_id} gap={2}>
                      <Checkbox
                        label={
                          <Text element="span" wrap="anywhere">
                            {t("marketplace.marketFollowing.select", {
                              title: offer.item_title,
                              offer: offer.offer_id,
                            })}
                          </Text>
                        }
                        checked={selected.includes(offer.offer_id)}
                        disabled={pending}
                        onCheckedChange={(checked) => {
                          setSelected((ids) =>
                            checked ? [...ids, offer.offer_id] : ids.filter((id) => id !== offer.offer_id),
                          );
                          edit();
                        }}
                      />
                      {selected.includes(offer.offer_id) ? (
                        <>
                          <Text>
                            {t("marketplace.marketFollowing.current", {
                              amount: offer.price_currency_code
                                ? formatMoney(offer.price_amount, offer.price_currency_code)
                                : "",
                              quantity: offer.quantity_requested,
                              currency: offer.price_currency_code ?? "",
                            })}
                          </Text>
                          <TextInput
                            label={t("marketplace.marketFollowing.maximum", { title: offer.item_title })}
                            inputMode="decimal"
                            required
                            value={caps[offer.offer_id] ?? offer.price_amount}
                            disabled={pending}
                            error={errorCopy}
                            onChange={(event) => {
                              setCaps({ ...caps, [offer.offer_id]: event.target.value });
                              edit();
                            }}
                          />
                        </>
                      ) : null}
                    </Stack>
                  ))}
                {!selectedOffers.length ? <Text>{t("marketplace.marketFollowing.empty")}</Text> : null}
                <TextInput
                  label={t("marketplace.marketFollowing.allowance")}
                  description={t("marketplace.marketFollowing.itemOnly")}
                  inputMode="decimal"
                  value={allowance}
                  required
                  disabled={pending}
                  error={errorCopy}
                  onChange={(event) => {
                    setAllowance(event.target.value);
                    edit();
                  }}
                />
                <ProgressiveDisclosure title={t("marketplace.marketFollowing.advanced")}>
                  <TextInput
                    label={t("marketplace.marketFollowing.adjustment")}
                    description={t("marketplace.marketFollowing.adjustmentHelp")}
                    inputMode="decimal"
                    value={adjustment}
                    disabled={pending}
                    error={errorCopy}
                    onChange={(event) => {
                      setAdjustment(event.target.value);
                      edit();
                    }}
                  />
                </ProgressiveDisclosure>
                <Button type="submit" disabled={pending || !editable}>
                  {t(
                    policy?.status === "paused"
                      ? "marketplace.marketFollowing.resumePreview"
                      : "marketplace.marketFollowing.preview",
                  )}
                </Button>
              </Form>
            ) : null}
            {review && reviewTerms && policy?.preview?.outcomes ? (
              <Stack gap={3}>
                <Text weight="semibold">{t("marketplace.marketFollowing.review")}</Text>
                <Text>
                  {t("marketplace.marketFollowing.reviewTerms", {
                    currency: reviewTerms.currency,
                    adjustment: reviewTerms.adjustmentBps / 100,
                    allowance: formatMoney(reviewTerms.itemCommitmentAllowance, reviewTerms.currency),
                  })}
                </Text>
                {policy.preview.outcomes.map((outcome) => {
                  const selection = reviewTerms.offers.find((offer) => offer.offerId === outcome.offerId)!;
                  const market = outcome.result.evidence.marketPrice as {
                    amount?: string;
                    currencyCode?: string;
                    estimateVersion?: string;
                    freshUntil?: string;
                  } | null;
                  return (
                    <Stack key={outcome.offerId} gap={2}>
                      <Text wrap="anywhere">
                        {t("marketplace.marketFollowing.selection", {
                          offer: selection.offerId,
                          product: selection.productId,
                          quantity: selection.quantity,
                          amount: formatMoney(selection.maximumUnitItemAmount, reviewTerms.currency),
                        })}
                      </Text>
                      {market?.amount && market.currencyCode && market.freshUntil ? (
                        <Text>
                          {t("marketplace.marketFollowing.evidence", {
                            amount: formatMoney(market.amount, market.currencyCode),
                            version: market.estimateVersion ?? "",
                            until: formatDateTime(market.freshUntil),
                          })}
                        </Text>
                      ) : null}
                      <Text>
                        {outcome.result.status === "target"
                          ? t("marketplace.marketFollowing.target", {
                              amount: formatMoney(outcome.result.unitItemAmount, reviewTerms.currency),
                            })
                          : t(`marketplace.marketFollowing.held.${outcome.result.reason}`)}
                      </Text>
                    </Stack>
                  );
                })}
                <Checkbox
                  label={t("marketplace.marketFollowing.consent")}
                  checked={consent}
                  disabled={pending}
                  onCheckedChange={(value) => setConsent(value === true)}
                />
                <Button disabled={pending || !consent} onClick={() => manage("AuthorizeBuyerOfferPolicy")}>
                  {t("marketplace.marketFollowing.authorize")}
                </Button>
              </Stack>
            ) : null}
            {policy?.status === "active" ? (
              <Button tone="secondary" disabled={pending} onClick={() => manage("PauseBuyerOfferPolicy")}>
                {t("marketplace.marketFollowing.pause")}
              </Button>
            ) : null}
            {policy?.policyId ? (
              <Stack gap={2}>
                <Checkbox
                  label={t("marketplace.marketFollowing.stopEffects")}
                  checked={confirmStop}
                  disabled={pending}
                  onCheckedChange={(value) => setConfirmStop(value === true)}
                />
                <Button
                  tone="secondary"
                  disabled={pending || !confirmStop}
                  onClick={() => manage("StopBuyerOfferPolicy")}
                >
                  {t("marketplace.marketFollowing.stop")}
                </Button>
              </Stack>
            ) : null}
          </>
        )}
      </Stack>
    </PageSection>
  );
}

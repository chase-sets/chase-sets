import { useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  CurrencyInput,
  DetailPanel,
  Fieldset,
  Form,
  Grid,
  HiddenInput,
  Inset,
  KeyValueList,
  NativeSelect,
  NumberField,
  Page,
  PageHeader,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { ListingEvidencePolicyRule } from "../domain/policy";
import type {
  ListingEvidencePolicyOverview,
  ListingEvidencePolicySelectorCatalog,
  ListingEvidencePolicyValidation,
} from "../api/runtime";

type GuidedRule = Readonly<{
  key: number;
  ruleId: string;
  explanationCode: string;
  priority: number;
  selectorKind: string;
  selectorValue: string;
  minimumPrice: string;
  maximumPrice: string;
  minimumPhotoCount: number;
  viewSet: string;
  minimumWidthPixels: number | null;
  minimumHeightPixels: number | null;
  maximumAgeHours: number | null;
  minimumTrustReviews: number;
  acceptedBadgeKey: string;
  buyerAcknowledgment: boolean;
}>;

const emptyRule = (key: number): GuidedRule => ({
  key,
  ruleId: `rule-${key}`,
  explanationCode: "listing-evidence.configured-rule",
  priority: key * 100,
  selectorKind: "all",
  selectorValue: "",
  minimumPrice: "",
  maximumPrice: "",
  minimumPhotoCount: 0,
  viewSet: "none",
  minimumWidthPixels: null,
  minimumHeightPixels: null,
  maximumAgeHours: null,
  minimumTrustReviews: 0,
  acceptedBadgeKey: "",
  buyerAcknowledgment: false,
});

function optionsForSelector(catalog: ListingEvidencePolicySelectorCatalog, kind: string) {
  const values =
    kind === "catalog-item"
      ? catalog.catalogItems
      : kind === "product"
        ? catalog.products
        : kind === "blueprint"
          ? catalog.blueprints
          : kind === "category"
            ? catalog.categories
            : kind === "option"
              ? catalog.options
              : kind === "seller-risk"
                ? catalog.sellerRiskLevels
                : [];
  return values.map((value) => ({
    value: value.id,
    label: t("marketplace.features.listingEvidencePolicy.ui.selector.option.label", {
      label: value.label,
      id: value.id,
    }),
  }));
}

function requiredSlots(rule: GuidedRule) {
  const constraints = {
    minimumWidthPixels: rule.minimumWidthPixels,
    minimumHeightPixels: rule.minimumHeightPixels,
    maximumAgeHours: rule.maximumAgeHours,
  };
  if (rule.viewSet === "slab-front-back") {
    return ["slab", "front", "back"].map((viewKind) => ({ slotId: viewKind, viewKind, ...constraints }));
  }
  if (rule.viewSet === "condition") return [{ slotId: "condition", viewKind: "condition", ...constraints }];
  return [];
}

function toPolicyRule(rule: GuidedRule, catalog: ListingEvidencePolicySelectorCatalog): ListingEvidencePolicyRule {
  const option = catalog.options.find((candidate) => candidate.id === rule.selectorValue);
  return {
    ruleId: rule.ruleId,
    explanationCode: rule.explanationCode,
    priority: rule.priority,
    selector: {
      catalogItemIds: rule.selectorKind === "catalog-item" && rule.selectorValue ? [rule.selectorValue] : [],
      productIds: rule.selectorKind === "product" && rule.selectorValue ? [rule.selectorValue] : [],
      blueprintIds: rule.selectorKind === "blueprint" && rule.selectorValue ? [rule.selectorValue] : [],
      categoryIds: rule.selectorKind === "category" && rule.selectorValue ? [rule.selectorValue] : [],
      options:
        rule.selectorKind === "option" && rule.selectorValue && option?.parentId
          ? [{ dimensionId: option.parentId, optionId: rule.selectorValue }]
          : [],
      gradedItem: rule.selectorKind === "graded-item" ? true : null,
      priceBand:
        rule.selectorKind === "price" && (rule.minimumPrice || rule.maximumPrice)
          ? { minimumAmount: rule.minimumPrice || null, maximumAmount: rule.maximumPrice || null }
          : null,
      seller: {
        minimumReviewCount:
          rule.selectorKind === "seller-reviews" && rule.selectorValue ? Number(rule.selectorValue) : null,
        badgeKeys: rule.selectorKind === "seller-badge" && rule.selectorValue ? [rule.selectorValue] : [],
        riskLevels: rule.selectorKind === "seller-risk" && rule.selectorValue ? [rule.selectorValue] : [],
      },
    },
    outcome: {
      minimumPhotoCount: rule.minimumPhotoCount,
      requiredSlots: requiredSlots(rule),
      sellerTrust:
        rule.minimumTrustReviews > 0 || rule.acceptedBadgeKey
          ? {
              satisfaction: "any",
              minimumReviewCount: rule.minimumTrustReviews,
              acceptedBadgeKeys: rule.acceptedBadgeKey ? [rule.acceptedBadgeKey] : [],
            }
          : null,
      buyerAcknowledgment: rule.buyerAcknowledgment ? "required" : "none",
    },
  };
}

function lifecycleLabel(lifecycle: string) {
  if (lifecycle === "draft") return t("marketplace.features.listingEvidencePolicy.ui.lifecycle.draft");
  if (lifecycle === "validated") return t("marketplace.features.listingEvidencePolicy.ui.lifecycle.validated");
  if (lifecycle === "scheduled") return t("marketplace.features.listingEvidencePolicy.ui.lifecycle.scheduled");
  if (lifecycle === "active") return t("marketplace.features.listingEvidencePolicy.ui.lifecycle.active");
  if (lifecycle === "superseded") return t("marketplace.features.listingEvidencePolicy.ui.lifecycle.superseded");
  return t("marketplace.features.listingEvidencePolicy.ui.lifecycle.rejected");
}

export function ListingEvidencePolicyPage({
  overview,
  selectorCatalog,
  permissions,
  validation,
  error,
}: Readonly<{
  overview: ListingEvidencePolicyOverview;
  selectorCatalog: ListingEvidencePolicySelectorCatalog;
  permissions: readonly string[];
  validation?: (ListingEvidencePolicyValidation & Readonly<{ documentId: string; version: number }>) | null;
  error?: string | null;
}>) {
  const [policyName, setPolicyName] = useState(() =>
    t("marketplace.features.listingEvidencePolicy.ui.default.policy.name"),
  );
  const [rules, setRules] = useState<GuidedRule[]>([emptyRule(1)]);
  const canDraft = permissions.includes("listing-evidence-policy.draft");
  const canValidate = permissions.includes("listing-evidence-policy.validate");
  const canActivate = permissions.includes("listing-evidence-policy.activate");
  const serializedRules = JSON.stringify(rules.map((rule) => toPolicyRule(rule, selectorCatalog)));

  const updateRule = (key: number, patch: Partial<GuidedRule>) =>
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listingEvidencePolicy.ui.eyebrow")}
        title={t("marketplace.features.listingEvidencePolicy.ui.title")}
        description={t("marketplace.features.listingEvidencePolicy.ui.description")}
      />

      {error ? (
        <Text tone="danger" role="alert">
          {error}
        </Text>
      ) : null}

      <Grid columns={2} gap={4}>
        <DetailPanel title={t("marketplace.features.listingEvidencePolicy.ui.current.title")}>
          <KeyValueList
            items={[
              {
                key: t("marketplace.features.listingEvidencePolicy.ui.policy.id"),
                value:
                  overview.current.policyId ?? t("marketplace.features.listingEvidencePolicy.ui.compiled.fallback"),
              },
              {
                key: t("marketplace.features.listingEvidencePolicy.ui.version"),
                value: overview.current.version ?? "—",
              },
              { key: t("marketplace.features.listingEvidencePolicy.ui.hash"), value: overview.current.hash },
              {
                key: t("marketplace.features.listingEvidencePolicy.ui.effective.from"),
                value: overview.current.effectiveFrom ?? "—",
              },
              {
                key: t("marketplace.features.listingEvidencePolicy.ui.effective.until"),
                value: overview.current.effectiveUntil ?? t("marketplace.features.listingEvidencePolicy.ui.open.ended"),
              },
            ]}
          />
          <Text>
            {t("marketplace.features.listingEvidencePolicy.ui.rule.count", {
              count: overview.current.value.rules.length,
            })}
          </Text>
        </DetailPanel>

        <DetailPanel title={t("marketplace.features.listingEvidencePolicy.ui.lifecycle.title")}>
          <Stack gap={2}>
            {overview.documents.map((document) => (
              <Inset key={document.policyId}>
                <Stack gap={2}>
                  <Stack direction="row" gap={2} align="center">
                    <Badge
                      tone={
                        document.lifecycle === "active"
                          ? "success"
                          : document.lifecycle === "rejected"
                            ? "danger"
                            : "info"
                      }
                    >
                      {lifecycleLabel(document.lifecycle)}
                    </Badge>
                    <Text size="sm">
                      {document.policyId} · v{document.version}
                    </Text>
                  </Stack>
                  <Text size="sm" tone="secondary">
                    {document.hash}
                  </Text>
                  <Stack direction="row" gap={2}>
                    {canValidate && document.lifecycle === "draft" ? (
                      <Form method="post">
                        <HiddenInput name="intent" value="validate" readOnly />
                        <HiddenInput name="policyId" value={document.policyId} readOnly />
                        <Button type="submit" tone="secondary">
                          {t("marketplace.features.listingEvidencePolicy.ui.validate")}
                        </Button>
                      </Form>
                    ) : null}
                    {canDraft && ["draft", "validated"].includes(document.lifecycle) ? (
                      <Form method="post">
                        <HiddenInput name="intent" value="reject" readOnly />
                        <HiddenInput name="policyId" value={document.policyId} readOnly />
                        <Button type="submit" tone="danger">
                          {t("marketplace.features.listingEvidencePolicy.ui.reject")}
                        </Button>
                      </Form>
                    ) : null}
                    {canDraft && document.lifecycle === "active" ? (
                      <Form method="post">
                        <HiddenInput name="intent" value="rollback" readOnly />
                        <HiddenInput name="policyId" value={document.policyId} readOnly />
                        <Button type="submit" tone="secondary">
                          {t("marketplace.features.listingEvidencePolicy.ui.rollback")}
                        </Button>
                      </Form>
                    ) : null}
                  </Stack>
                </Stack>
              </Inset>
            ))}
          </Stack>
        </DetailPanel>
      </Grid>

      {validation ? (
        <DetailPanel title={t("marketplace.features.listingEvidencePolicy.ui.impact.title")}>
          <Stack gap={3}>
            <Text>
              {t("marketplace.features.listingEvidencePolicy.ui.impact.count", {
                count: validation.impactPreview.impactedListingCount,
              })}
            </Text>
            <Text size="sm">
              {t("marketplace.features.listingEvidencePolicy.ui.diff", {
                added: validation.semanticDiff.addedRuleIds.join(", ") || "—",
                changed: validation.semanticDiff.changedRuleIds.join(", ") || "—",
                removed: validation.semanticDiff.removedRuleIds.join(", ") || "—",
              })}
            </Text>
            {validation.diagnostics.map((diagnostic) => (
              <Text key={`${diagnostic.path}:${diagnostic.code}`} tone="danger">
                {diagnostic.path}: {diagnostic.message}
              </Text>
            ))}
            {canActivate && validation.valid ? (
              <Form method="post" spacing="lg">
                <HiddenInput name="intent" value="activate" readOnly />
                <HiddenInput name="policyId" value={validation.documentId} readOnly />
                <HiddenInput name="impactAcknowledgmentHash" value={validation.impactPreview.previewHash} readOnly />
                <Grid columns={2} gap={3}>
                  <TextInput
                    type="datetime-local"
                    name="effectiveFrom"
                    label={t("marketplace.features.listingEvidencePolicy.ui.effective.from")}
                    required
                  />
                  <TextInput
                    type="datetime-local"
                    name="effectiveUntil"
                    label={t("marketplace.features.listingEvidencePolicy.ui.effective.until")}
                  />
                </Grid>
                <Checkbox
                  name="impactAcknowledged"
                  value="yes"
                  label={t("marketplace.features.listingEvidencePolicy.ui.impact.acknowledge")}
                  required
                />
                <Button type="submit">{t("marketplace.features.listingEvidencePolicy.ui.activate")}</Button>
              </Form>
            ) : null}
          </Stack>
        </DetailPanel>
      ) : null}

      {canDraft ? (
        <DetailPanel title={t("marketplace.features.listingEvidencePolicy.ui.draft.title")}>
          <Form method="post" spacing="lg">
            <HiddenInput name="intent" value="create-draft" readOnly />
            <HiddenInput name="rules" value={serializedRules} readOnly />
            <TextInput
              name="policyName"
              label={t("marketplace.features.listingEvidencePolicy.ui.policy.name")}
              value={policyName}
              onChange={(event) => setPolicyName(event.target.value)}
              required
            />
            <Stack gap={4}>
              {rules.map((rule, index) => {
                const selectorOptions = optionsForSelector(selectorCatalog, rule.selectorKind);
                return (
                  <Inset key={rule.key}>
                    <Stack gap={4}>
                      <Text weight="semibold">
                        {t("marketplace.features.listingEvidencePolicy.ui.rule.title", { number: index + 1 })}
                      </Text>
                      <Grid columns={3} gap={3}>
                        <TextInput
                          label={t("marketplace.features.listingEvidencePolicy.ui.rule.id")}
                          value={rule.ruleId}
                          onChange={(event) => updateRule(rule.key, { ruleId: event.target.value })}
                          required
                        />
                        <TextInput
                          label={t("marketplace.features.listingEvidencePolicy.ui.explanation.code")}
                          value={rule.explanationCode}
                          onChange={(event) => updateRule(rule.key, { explanationCode: event.target.value })}
                          required
                        />
                        <NumberField
                          label={t("marketplace.features.listingEvidencePolicy.ui.priority")}
                          value={rule.priority}
                          onValueChange={(value) => updateRule(rule.key, { priority: value ?? 0 })}
                          min={0}
                        />
                      </Grid>
                      <Fieldset
                        legend={t("marketplace.features.listingEvidencePolicy.ui.selector.title")}
                        description={t("marketplace.features.listingEvidencePolicy.ui.selector.description")}
                      >
                        <Grid columns={2} gap={3}>
                          <NativeSelect
                            label={t("marketplace.features.listingEvidencePolicy.ui.selector.kind")}
                            value={rule.selectorKind}
                            onChange={(event) =>
                              updateRule(rule.key, { selectorKind: event.target.value, selectorValue: "" })
                            }
                            items={[
                              {
                                value: "all",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.all"),
                              },
                              {
                                value: "catalog-item",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.catalog.item"),
                              },
                              {
                                value: "product",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.product"),
                              },
                              {
                                value: "blueprint",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.blueprint"),
                              },
                              {
                                value: "category",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.category"),
                              },
                              {
                                value: "option",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.option"),
                              },
                              {
                                value: "graded-item",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.graded"),
                              },
                              {
                                value: "price",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.price"),
                              },
                              {
                                value: "seller-reviews",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.seller.reviews"),
                              },
                              {
                                value: "seller-badge",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.seller.badge"),
                              },
                              {
                                value: "seller-risk",
                                label: t("marketplace.features.listingEvidencePolicy.ui.selector.seller.risk"),
                              },
                            ]}
                          />
                          {rule.selectorKind === "price" ? (
                            <Stack gap={2}>
                              <CurrencyInput
                                currencyCode="USD"
                                label={t("marketplace.features.listingEvidencePolicy.ui.minimum.price")}
                                value={rule.minimumPrice}
                                onValueChange={(value) => updateRule(rule.key, { minimumPrice: value ?? "" })}
                              />
                              <CurrencyInput
                                currencyCode="USD"
                                label={t("marketplace.features.listingEvidencePolicy.ui.maximum.price")}
                                value={rule.maximumPrice}
                                onValueChange={(value) => updateRule(rule.key, { maximumPrice: value ?? "" })}
                              />
                            </Stack>
                          ) : selectorOptions.length > 0 ? (
                            <NativeSelect
                              label={t("marketplace.features.listingEvidencePolicy.ui.selector.value")}
                              value={rule.selectorValue}
                              onChange={(event) => updateRule(rule.key, { selectorValue: event.target.value })}
                              items={selectorOptions}
                              placeholder={t("marketplace.features.listingEvidencePolicy.ui.selector.choose")}
                            />
                          ) : ["seller-reviews", "seller-badge"].includes(rule.selectorKind) ? (
                            <TextInput
                              label={t("marketplace.features.listingEvidencePolicy.ui.selector.value")}
                              value={rule.selectorValue}
                              onChange={(event) => updateRule(rule.key, { selectorValue: event.target.value })}
                            />
                          ) : null}
                        </Grid>
                      </Fieldset>
                      <Fieldset legend={t("marketplace.features.listingEvidencePolicy.ui.requirements.title")}>
                        <Grid columns={3} gap={3}>
                          <NumberField
                            label={t("marketplace.features.listingEvidencePolicy.ui.minimum.photos")}
                            value={rule.minimumPhotoCount}
                            onValueChange={(value) => updateRule(rule.key, { minimumPhotoCount: value ?? 0 })}
                            min={0}
                            max={100}
                          />
                          <NativeSelect
                            label={t("marketplace.features.listingEvidencePolicy.ui.view.set")}
                            value={rule.viewSet}
                            onChange={(event) => updateRule(rule.key, { viewSet: event.target.value })}
                            items={[
                              { value: "none", label: t("marketplace.features.listingEvidencePolicy.ui.view.none") },
                              {
                                value: "condition",
                                label: t("marketplace.features.listingEvidencePolicy.ui.view.condition"),
                              },
                              {
                                value: "slab-front-back",
                                label: t("marketplace.features.listingEvidencePolicy.ui.view.slab.front.back"),
                              },
                            ]}
                          />
                          <NumberField
                            label={t("marketplace.features.listingEvidencePolicy.ui.minimum.trust.reviews")}
                            value={rule.minimumTrustReviews}
                            onValueChange={(value) => updateRule(rule.key, { minimumTrustReviews: value ?? 0 })}
                            min={0}
                          />
                          <NumberField
                            label={t("marketplace.features.listingEvidencePolicy.ui.minimum.width")}
                            value={rule.minimumWidthPixels}
                            onValueChange={(value) => updateRule(rule.key, { minimumWidthPixels: value })}
                            min={1}
                          />
                          <NumberField
                            label={t("marketplace.features.listingEvidencePolicy.ui.minimum.height")}
                            value={rule.minimumHeightPixels}
                            onValueChange={(value) => updateRule(rule.key, { minimumHeightPixels: value })}
                            min={1}
                          />
                          <NumberField
                            label={t("marketplace.features.listingEvidencePolicy.ui.maximum.age")}
                            value={rule.maximumAgeHours}
                            onValueChange={(value) => updateRule(rule.key, { maximumAgeHours: value })}
                            min={1}
                          />
                          <TextInput
                            label={t("marketplace.features.listingEvidencePolicy.ui.accepted.badge")}
                            value={rule.acceptedBadgeKey}
                            onChange={(event) => updateRule(rule.key, { acceptedBadgeKey: event.target.value })}
                          />
                          <Checkbox
                            label={t("marketplace.features.listingEvidencePolicy.ui.buyer.acknowledgment")}
                            checked={rule.buyerAcknowledgment}
                            onCheckedChange={(checked) =>
                              updateRule(rule.key, { buyerAcknowledgment: checked === true })
                            }
                          />
                        </Grid>
                      </Fieldset>
                      {rules.length > 1 ? (
                        <Button
                          type="button"
                          tone="danger"
                          onClick={() =>
                            setRules((current) => current.filter((candidate) => candidate.key !== rule.key))
                          }
                        >
                          {t("marketplace.features.listingEvidencePolicy.ui.remove.rule")}
                        </Button>
                      ) : null}
                    </Stack>
                  </Inset>
                );
              })}
            </Stack>
            <Stack direction="row" gap={2}>
              <Button
                type="button"
                tone="secondary"
                onClick={() =>
                  setRules((current) => [...current, emptyRule(Math.max(...current.map((rule) => rule.key)) + 1)])
                }
              >
                {t("marketplace.features.listingEvidencePolicy.ui.add.rule")}
              </Button>
              <Button type="submit">{t("marketplace.features.listingEvidencePolicy.ui.create.draft")}</Button>
            </Stack>
          </Form>
        </DetailPanel>
      ) : null}
    </Page>
  );
}

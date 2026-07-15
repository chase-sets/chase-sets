import {
  Grid,
  HiddenInput,
  Form,
  Badge,
  Button,
  Card,
  Checkbox,
  ComparisonModule,
  DataTable,
  LinkButton,
  NativeSelect,
  NumberField,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { PackagePlan } from "@chase-sets/product-measures";
import type { PostagePolicyAdminViewModel } from "./contracts";
import {
  PostagePolicyFormFields,
  postagePolicyPhysicalFlags,
  postagePolicyShippingOptions,
} from "./postage-policy-form-fields";

function statusTone(status: string) {
  return status === "active" ? "success" : status === "retired" ? "neutral" : "warning";
}

export function PostagePolicyDetailPage({
  policy,
  previewResult,
  errorMessage,
}: {
  policy: PostagePolicyAdminViewModel;
  previewResult?: PackagePlan | null;
  errorMessage?: string | null;
}) {
  const history = policy.history ?? [];
  const activeComparison = policy.activeComparison ?? [];
  const noValue = t("ordering.features.postagePolicies.ui.common.none");

  return (
    <Page>
      <PageHeader
        eyebrow={t("ordering.features.postagePolicies.ui.common.ordering")}
        title={policy.label}
        description={t("ordering.features.postagePolicies.ui.detail.description")}
        actions={
          <LinkButton href="/commerce/postage-policies" tone="secondary">
            {t("ordering.features.postagePolicies.ui.common.back")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("ordering.features.postagePolicies.ui.detail.state")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(policy.status)}>{policy.status}</Badge>
            <Text>{t("ordering.features.postagePolicies.ui.detail.policy.id", { policyId: policy.policy_id })}</Text>
            <Text>
              {t("ordering.features.postagePolicies.ui.detail.activated", {
                value: policy.activated_at ?? t("ordering.features.postagePolicies.ui.detail.not.activated"),
              })}
            </Text>
            <Text>
              {t("ordering.features.postagePolicies.ui.detail.activation.reason", {
                value: policy.activation_reason ?? noValue,
              })}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.detail.active.comparison")}>
        <ComparisonModule
          description={
            activeComparison.length === 0
              ? policy.status === "active"
                ? t("ordering.features.postagePolicies.ui.detail.this.is.active.policy")
                : t("ordering.features.postagePolicies.ui.detail.no.active.differences")
              : t("ordering.features.postagePolicies.ui.detail.material.differences.only")
          }
          signalLabel={t("ordering.features.postagePolicies.ui.detail.field")}
          columns={[
            t("ordering.features.postagePolicies.ui.detail.active"),
            t("ordering.features.postagePolicies.ui.detail.this.policy"),
          ]}
          rows={activeComparison.map((row) => ({
            label: row.field,
            values: [row.activeValue, row.candidateValue],
          }))}
        />
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.detail.revise.policy")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={4}>
              <HiddenInput type="hidden" name="intent" value="revise" readOnly />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.label")}
                name="label"
                defaultValue={policy.label}
                required
              />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.effective.from")}
                name="effectiveFrom"
                defaultValue={policy.effective_from}
                required
              />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.effective.until")}
                name="effectiveUntil"
                defaultValue={policy.effective_until ?? ""}
              />
              <PostagePolicyFormFields policy={policy.payload} />
              <Button type="submit">{t("ordering.features.postagePolicies.ui.detail.save.revision")}</Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.detail.preview")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={4}>
              <HiddenInput type="hidden" name="intent" value="preview" readOnly />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.label")}
                name="label"
                defaultValue={policy.label}
                required
              />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.effective.from")}
                name="effectiveFrom"
                defaultValue={policy.effective_from}
                required
              />
              <TextInput
                label={t("ordering.features.postagePolicies.ui.common.effective.until")}
                name="effectiveUntil"
                defaultValue={policy.effective_until ?? ""}
              />
              <PostagePolicyFormFields policy={policy.payload} />
              <Grid columns={{ base: 1, md: 2 }} gap={3}>
                <NativeSelect
                  label={t("ordering.features.postagePolicies.ui.detail.shipping.option")}
                  name="previewShippingOption"
                  defaultValue="standard"
                  items={[...postagePolicyShippingOptions]}
                />
                <TextInput
                  label={t("ordering.features.postagePolicies.ui.detail.item.subtotal")}
                  name="previewItemSubtotalAmount"
                  defaultValue="25.00"
                  required
                />
                <NumberField
                  label={t("ordering.features.postagePolicies.ui.detail.quantity")}
                  name="previewQuantity"
                  min={1}
                  defaultValue={1}
                  required
                />
                <NumberField
                  label={t("ordering.features.postagePolicies.ui.detail.unit.length.in")}
                  name="previewUnitLengthInches"
                  min={0.01}
                  step={0.01}
                  defaultValue={3.5}
                  required
                />
                <NumberField
                  label={t("ordering.features.postagePolicies.ui.detail.unit.width.in")}
                  name="previewUnitWidthInches"
                  min={0.01}
                  step={0.01}
                  defaultValue={2.5}
                  required
                />
                <NumberField
                  label={t("ordering.features.postagePolicies.ui.detail.unit.thickness.in")}
                  name="previewUnitHeightInches"
                  min={0.001}
                  step={0.001}
                  defaultValue={0.016}
                  required
                />
                <NumberField
                  label={t("ordering.features.postagePolicies.ui.detail.unit.weight.oz")}
                  name="previewUnitWeightOunces"
                  min={0.001}
                  step={0.001}
                  defaultValue={0.05}
                  required
                />
              </Grid>
              <Grid columns={{ base: 1, sm: 2, lg: 4 }} gap={2}>
                {postagePolicyPhysicalFlags
                  .filter((flag) => flag.value !== "bendable")
                  .map((flag) => (
                    <Checkbox
                      key={flag.value}
                      name="previewPhysicalFlags"
                      value={flag.value}
                      label={flag.label}
                      defaultChecked={flag.value === "raw-card"}
                    />
                  ))}
              </Grid>
              <Button type="submit">{t("ordering.features.postagePolicies.ui.detail.preview.result.action")}</Button>
            </Stack>
          </Form>
        </Card>

        {previewResult ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("ordering.features.postagePolicies.ui.detail.preview.result")}</Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.packages", { value: previewResult.packageCount })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.mailpiece", {
                  value: previewResult.packages[0]?.mailpieceClass ?? noValue,
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.service", {
                  value: previewResult.packages[0]?.serviceLevel ?? noValue,
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.parcel.required", {
                  value: previewResult.postagePolicySnapshot?.parcelRequired
                    ? t("ordering.features.postagePolicies.ui.common.yes")
                    : t("ordering.features.postagePolicies.ui.common.no"),
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.parcel.reasons", {
                  value: previewResult.postagePolicySnapshot?.parcelReasons.join(", ") || noValue,
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.signature.required", {
                  value: previewResult.postagePolicySnapshot?.signatureRequired
                    ? t("ordering.features.postagePolicies.ui.common.yes")
                    : t("ordering.features.postagePolicies.ui.common.no"),
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.signature.reasons", {
                  value: previewResult.postagePolicySnapshot?.signatureReasons.join(", ") || noValue,
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.insurance.required", {
                  value: previewResult.postagePolicySnapshot?.insuranceRequired
                    ? t("ordering.features.postagePolicies.ui.common.yes")
                    : t("ordering.features.postagePolicies.ui.common.no"),
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.insurance.reasons", {
                  value: previewResult.postagePolicySnapshot?.insuranceReasons.join(", ") || noValue,
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.insured.value", {
                  value: previewResult.postagePolicySnapshot?.insuredValueAmount ?? noValue,
                })}
              </Text>
              <Text>
                {t("ordering.features.postagePolicies.ui.detail.shipping.evidence.tier", {
                  value: previewResult.postagePolicySnapshot?.shippingEvidenceTier ?? noValue,
                })}
              </Text>
            </Stack>
          </Card>
        ) : null}
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.detail.lifecycle")}>
        <Grid columns={{ base: 1, md: 2 }} gap={3}>
          <Card>
            <Form spacing="none" method="post">
              <Stack gap={3}>
                <HiddenInput type="hidden" name="intent" value="activate" readOnly />
                <TextInput
                  label={t("ordering.features.postagePolicies.ui.detail.activation.reason.label")}
                  name="activationReason"
                  defaultValue={t("ordering.features.postagePolicies.ui.detail.activation.reason.default")}
                  required
                />
                <Button type="submit" disabled={policy.status === "active" || policy.status === "retired"}>
                  {t("ordering.features.postagePolicies.ui.detail.activate")}
                </Button>
              </Stack>
            </Form>
          </Card>
          <Card>
            <Form spacing="none" method="post">
              <Stack gap={3}>
                <HiddenInput type="hidden" name="intent" value="retire" readOnly />
                <TextInput
                  label={t("ordering.features.postagePolicies.ui.detail.retirement.reason.label")}
                  name="retirementReason"
                  defaultValue={t("ordering.features.postagePolicies.ui.detail.retirement.reason.default")}
                  required
                />
                <Button type="submit" tone="danger" disabled={policy.status === "retired"}>
                  {t("ordering.features.postagePolicies.ui.detail.retire")}
                </Button>
              </Stack>
            </Form>
          </Card>
          <Card>
            <Form spacing="none" method="post">
              <Stack gap={3}>
                <HiddenInput type="hidden" name="intent" value="clone" readOnly />
                <TextInput
                  label={t("ordering.features.postagePolicies.ui.detail.draft.label")}
                  name="cloneLabel"
                  defaultValue={t("ordering.features.postagePolicies.ui.detail.rollback.draft", {
                    label: policy.label,
                  })}
                  required
                />
                <TextInput
                  label={t("ordering.features.postagePolicies.ui.common.effective.from")}
                  name="cloneEffectiveFrom"
                  defaultValue={new Date().toISOString()}
                  required
                />
                <TextInput
                  label={t("ordering.features.postagePolicies.ui.common.effective.until")}
                  name="cloneEffectiveUntil"
                />
                <Button type="submit" tone="secondary">
                  {t("ordering.features.postagePolicies.ui.detail.clone.rollback.draft")}
                </Button>
              </Stack>
            </Form>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.detail.history")}>
        <DataTable
          rows={[...history]}
          getRowId={(row) => row.history_id}
          columns={[
            {
              key: "event",
              header: t("ordering.features.postagePolicies.ui.detail.event"),
              cell: (row) => row.event_type,
            },
            {
              key: "status",
              header: t("ordering.features.postagePolicies.ui.common.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "actor",
              header: t("ordering.features.postagePolicies.ui.detail.actor"),
              cell: (row) => row.actor_user_id,
            },
            {
              key: "reason",
              header: t("ordering.features.postagePolicies.ui.detail.reason"),
              cell: (row) => row.reason ?? noValue,
            },
            {
              key: "recorded",
              header: t("ordering.features.postagePolicies.ui.detail.recorded"),
              cell: (row) => row.recorded_at,
            },
          ]}
          emptyTitle={t("ordering.features.postagePolicies.ui.detail.no.history")}
          emptyDescription={t("ordering.features.postagePolicies.ui.detail.history.description")}
        />
      </PageSection>
    </Page>
  );
}

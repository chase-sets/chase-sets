import {
  Button,
  Checkbox,
  HiddenInput,
  OperationalStatusBanner,
  RadioGroup,
  Textarea,
  TextInput,
  WorkbenchActionRow,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { CommandHiddenInputs } from "./command-controls";
import { useCatalogIntegrationCommandHref } from "./command-action-context";

// Candidate edit form. Renders inline in the candidate review drawer. It
// submits the typed `update-merge-candidate` intent carrying the base snapshot
// plus the operator's overrides; the command handler applies them onto the base
// snapshot and calls UpdateCatalogMergeCandidate, so field corrections land as
// `manual` provenance and promotion carries the edited value. The row-level
// promote action stays available beside it — the operator edits then promotes.
export function CatalogMergeCandidateEditForm({
  row,
  readModel,
}: Readonly<{ row: CatalogPrimaryWorkbenchMergeCandidateReviewRow; readModel: CatalogPrimaryWorkbenchReadModel }>) {
  const editForm = row.editForm;
  const actionHref = useCatalogIntegrationCommandHref(readModel.routeContext);

  if (editForm.state !== "available" || !editForm.baseSnapshotJson) {
    return (
      <OperationalStatusBanner
        tone="warning"
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.blocked.title")}
        description={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.blocked.description",
        )}
      />
    );
  }

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.description")}
      headingLevel={3}
      density="compact"
    >
      <WorkbenchForm variant="surface" method="post" action={actionHref} data-catalog-merge-candidate-edit-form="true">
        <CommandHiddenInputs readModel={readModel} intent="update-merge-candidate" candidateId={row.candidateId} />
        <HiddenInput name="candidateEditBaseSnapshot" value={editForm.baseSnapshotJson} />
        <RadioGroup
          name="candidateEditPromotionIntent"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.promotionIntent")}
          defaultValue={editForm.promotionIntent}
          items={[
            {
              value: "create-catalog-item",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.intent.create"),
            },
            {
              value: "update-catalog-item",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.intent.update"),
            },
            {
              value: "link-existing-catalog-item",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.intent.link"),
            },
          ]}
        />
        <TextInput
          name="candidateEditCatalogItemId"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.catalogItemId")}
          defaultValue={editForm.catalogItemId ?? ""}
        />
        <TextInput
          name="candidateEditProductIds"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.productIds")}
          description={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.productIds.help",
          )}
          defaultValue={editForm.productIds.join(", ")}
        />
        <WorkbenchStack gap="sm">
          <WorkbenchText size="sm">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.facts.title")}
          </WorkbenchText>
          {editForm.editableFacts.length > 0 ? (
            editForm.editableFacts.map((fact) => (
              <TextInput
                key={fact.key}
                name={`candidateEditFact.${fact.key}`}
                label={fact.label}
                defaultValue={fact.value}
              />
            ))
          ) : (
            <WorkbenchText size="xs">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.facts.empty")}
            </WorkbenchText>
          )}
        </WorkbenchStack>
        <CandidateEditReferenceGroup
          title={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.references.catalogItem",
          )}
          fieldPrefix="candidateEditDropCatalogRef"
          references={editForm.externalCatalogItemReferences}
        />
        <CandidateEditReferenceGroup
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.references.product")}
          fieldPrefix="candidateEditDropProductRef"
          references={editForm.externalProductReferences}
        />
        <Textarea
          name="reason"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.reason")}
          required
          rows={2}
        />
        <WorkbenchActionRow align="end">
          <Button type="submit" tone="primary" size="sm">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.submit")}
          </Button>
        </WorkbenchActionRow>
      </WorkbenchForm>
    </WorkflowModule>
  );
}

function CandidateEditReferenceGroup({
  title,
  fieldPrefix,
  references,
}: Readonly<{
  title: string;
  fieldPrefix: string;
  references: CatalogPrimaryWorkbenchMergeCandidateReviewRow["editForm"]["externalCatalogItemReferences"];
}>) {
  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText size="sm">{title}</WorkbenchText>
      {references.length > 0 ? (
        references.map((reference) => (
          <Checkbox
            key={reference.index}
            name={`${fieldPrefix}.${reference.index}`}
            label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.references.drop", {
              reference: reference.label,
            })}
          />
        ))
      ) : (
        <WorkbenchText size="xs">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.edit.references.empty")}
        </WorkbenchText>
      )}
    </WorkbenchStack>
  );
}

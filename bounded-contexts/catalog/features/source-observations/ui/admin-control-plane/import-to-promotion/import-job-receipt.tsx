import { KeyValueList, WorkbenchStack, WorkbenchText } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { SourceObservationImportJobReceipt } from "../../contracts";

// Visible scalar DOM contract: the versioned root and field/kind attributes
// follow the original promotion receipt; no framework state is needed to read it.
export function CatalogImportJobReceipt({ receipt }: Readonly<{ receipt: SourceObservationImportJobReceipt }>) {
  const fields: readonly (readonly [string, string | null])[] = [
    ["schemaVersion", receipt.schemaVersion],
    ["jobId", receipt.jobId],
    ["status", receipt.status],
    ["submitted.providerKey", receipt.submitted.providerKey],
    ["submitted.unitKey", receipt.submitted.unitKey],
    ["submitted.profileVersion", receipt.submitted.profileVersion],
    ...(
      [
        "provider",
        "profileKey",
        "ingestionUnitKey",
        "language",
        "seriesId",
        "setId",
        "productLineId",
        "setName",
        "productId",
        "planningFingerprint",
      ] as const
    ).flatMap((key): (readonly [string, string])[] => {
      const value = receipt.scope[key];
      return typeof value === "string" ? [[`scope.${key}`, value]] : [];
    }),
  ];
  return (
    <WorkbenchStack data-catalog-import-job-receipt={receipt.schemaVersion}>
      <KeyValueList
        items={fields.map(([key, value]) => ({
          key,
          value: (
            <WorkbenchText
              size="xs"
              mono
              wrap="anywhere"
              data-catalog-receipt-field={key}
              data-catalog-receipt-kind={value === null ? "null" : value === "" ? "empty-string" : "string"}
            >
              {value === null
                ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.receipt.notReturned")
                : value === ""
                  ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.receipt.emptyString")
                  : value}
            </WorkbenchText>
          ),
        }))}
      />
    </WorkbenchStack>
  );
}

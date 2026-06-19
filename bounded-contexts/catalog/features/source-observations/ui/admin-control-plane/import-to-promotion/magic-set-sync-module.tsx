import {
  Badge,
  Button,
  DataTable,
  HiddenInput,
  LinkButton,
  NativeSelect,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchStack,
  WorkbenchText,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionReadModel,
  CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";

type MagicSetProviderRow = CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel;

export function CatalogMagicSetSyncModule({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const sync = readModel.magicSetSync;
  if (sync.providers.length === 0) {
    return null;
  }

  return (
    <WorkbenchDetailPanel data-catalog-magic-set-sync={sync.status}>
      <WorkbenchStack>
        <WorkbenchActionRow align="between" stackOnMobile>
          <WorkbenchStack gap="sm">
            <WorkbenchText tone="foreground" weight="semibold">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.title")}
            </WorkbenchText>
            <WorkbenchText size="sm" tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.description")}
            </WorkbenchText>
          </WorkbenchStack>
          <Badge tone={syncStatusTone(sync.status)}>{sync.status}</Badge>
        </WorkbenchActionRow>

        <MagicSetSelectionForm readModel={readModel} />

        <WorkbenchActionRow align="start" stackOnMobile>
          <WorkbenchDataCell
            title={String(sync.summary.changedObservationCount)}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.changed")}
          />
          <WorkbenchDataCell
            title={String(sync.summary.promotedObservationCount)}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.promoted")}
          />
          <WorkbenchDataCell
            title={String(sync.summary.activeImportCount)}
            description={t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.activeImports")}
          />
        </WorkbenchActionRow>

        <DataTable rows={[...sync.providers]} columns={[...magicSetProviderColumns(readModel)]} density="compact" />
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

function MagicSetSelectionForm({ readModel }: { readModel: CatalogPrimaryWorkbenchReadModel }) {
  const sync = readModel.magicSetSync;
  const selectedValue = sync.selectedSet.setId ?? "";
  const providerKey = readModel.routeContext.providerKey ?? sync.providers[0]?.providerKey ?? "";
  const selectedProvider = sync.providers.find((provider) => provider.providerKey === providerKey) ?? sync.providers[0];

  return (
    <WorkbenchForm method="get" action="/catalog/integrations" data-catalog-magic-set-selector="true">
      <HiddenInput name="providerKey" value={selectedProvider?.providerKey ?? providerKey} />
      <HiddenInput name="unitKey" value={selectedProvider?.unitKey ?? ""} />
      <HiddenInput name="profileVersion" value={selectedProvider?.profileVersion ?? ""} />
      <HiddenInput name="languageCode" value={readModel.routeContext.scope?.languageCode ?? "en"} />
      <HiddenInput name="productLineName" value="Magic: The Gathering" />
      <WorkbenchFormGrid columns="three">
        <NativeSelect
          name="expansionId"
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.set.label")}
          placeholder={t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.set.placeholder")}
          items={sync.setOptions.map((option) => ({
            value: option.setId,
            label: option.label,
            description: option.providerKey,
          }))}
          defaultValue={selectedValue || undefined}
          required
        />
      </WorkbenchFormGrid>
      <WorkbenchActionRow align="between" stackOnMobile>
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.currentSet", {
            setLabel: sync.selectedSet.label,
          })}
        </WorkbenchText>
        <Button type="submit" leadingIcon="check" disabled={sync.setOptions.length === 0}>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.set.submit")}
        </Button>
      </WorkbenchActionRow>
    </WorkbenchForm>
  );
}

function magicSetProviderColumns(
  readModel: CatalogPrimaryWorkbenchReadModel,
): readonly DataColumn<MagicSetProviderRow>[] {
  return [
    {
      key: "provider",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.provider"),
      cell: (row) => (
        <WorkbenchDataCell
          title={row.displayName}
          description={
            row.unitKey ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.noActiveUnit")
          }
          detail={
            row.profileVersion
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.profileVersion", {
                  profileVersion: row.profileVersion,
                })
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.noActiveProfile")
          }
        />
      ),
    },
    {
      key: "state",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.state"),
      cell: (row) => (
        <WorkbenchStack gap="sm">
          <Badge tone={providerStateTone(row.state)}>{row.state}</Badge>
          <WorkbenchText size="xs" tone="secondary">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.counts", {
              observed: row.counts.observed,
              changed: row.counts.changed,
              promoted: row.counts.promoted,
            })}
          </WorkbenchText>
        </WorkbenchStack>
      ),
    },
    {
      key: "actions",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.actions"),
      cell: (row) => (
        <WorkbenchActionRow align="start" stackOnMobile>
          <LinkButton size="sm" tone="secondary" leadingIcon="externalLink" href={row.currentWorkbenchHref}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.openProviderSet")}
          </LinkButton>
          <MagicSetCommandButton readModel={readModel} row={row} action={row.actions.import}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.syncProvider", {
              provider: row.displayName,
            })}
          </MagicSetCommandButton>
          <MagicSetCommandButton readModel={readModel} row={row} action={row.actions.previewPromotion}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.previewProvider", {
              provider: row.displayName,
            })}
          </MagicSetCommandButton>
          <MagicSetCommandButton readModel={readModel} row={row} action={row.actions.reapply}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.magicSetSync.reapplyProvider", {
              provider: row.displayName,
            })}
          </MagicSetCommandButton>
        </WorkbenchActionRow>
      ),
    },
  ];
}

function MagicSetCommandButton({
  readModel,
  row,
  action,
  children,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  row: MagicSetProviderRow;
  action: CatalogPrimaryWorkbenchActionReadModel;
  children: React.ReactNode;
}) {
  const available = action.state === "available" || action.state === "degraded";

  return (
    <WorkbenchForm
      variant="button"
      method="post"
      action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
      data-catalog-primary-workbench-command={action.key}
      data-catalog-magic-set-provider={row.providerKey}
    >
      <HiddenInput name="_intent" value={action.key} />
      <HiddenInput name="providerKey" value={row.commandContext.providerKey} />
      <HiddenInput name="unitKey" value={row.commandContext.unitKey ?? ""} />
      <HiddenInput name="importScope" value={row.commandContext.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={row.commandContext.profileVersion ?? ""} />
      <HiddenInput name="languageCode" value={row.commandContext.languageCode ?? ""} />
      <HiddenInput name="productLineId" value={row.commandContext.productLineId ?? ""} />
      <HiddenInput name="productLineName" value={row.commandContext.productLineName ?? ""} />
      <HiddenInput name="seriesId" value={row.commandContext.seriesId ?? ""} />
      <HiddenInput name="seriesName" value={row.commandContext.seriesName ?? ""} />
      <HiddenInput name="expansionId" value={row.commandContext.expansionId ?? ""} />
      <HiddenInput name="expansionName" value={row.commandContext.expansionName ?? ""} />
      <HiddenInput name="selectedObservationIds" value="" />
      <HiddenInput name="promotionPreviewId" value="" />
      <Button type="submit" size="sm" tone="ghost" disabled={!available}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

function syncStatusTone(
  status: CatalogPrimaryWorkbenchReadModel["magicSetSync"]["status"],
): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (status) {
    case "ready":
      return "success";
    case "degraded":
    case "set-required":
      return "warning";
    case "blocked":
      return "danger";
    case "not-configured":
      return "neutral";
  }
}

function providerStateTone(
  state: CatalogPrimaryWorkbenchMagicSetSyncProviderReadModel["state"],
): "success" | "warning" | "danger" | "neutral" | "info" {
  switch (state) {
    case "promoted":
      return "success";
    case "changed":
      return "warning";
    case "blocked":
      return "danger";
    case "imported":
      return "info";
    case "not-imported":
      return "neutral";
  }
}

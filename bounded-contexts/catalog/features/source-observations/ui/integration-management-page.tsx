import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import { useEffect, useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  ActionBar,
  Combobox,
  DataTable,
  Dialog,
  FilterBar,
  Inline,
  KeyValueList,
  LinkButton,
  Page,
  PageHeader,
  ProgressBar,
  SegmentedControl,
  Select,
  Stack,
  Stat,
  StatGrid,
  StatusPill,
  TextInput,
  Textarea,
  type DataColumn,
  type SegmentedControlItem,
  type SelectItem,
} from "@chase-sets/design-system";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import type { CatalogBulkActionProgress } from "../../../support/shell-support/api/client";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileBasicsUpdateCommand,
  CatalogProviderProfileConnectorUpdateCommand,
  CatalogProviderProfileDryRunResult,
  CatalogProviderProfileFixturesUpdateCommand,
  CatalogProviderProfileNormalizedObservationUpdateCommand,
  CatalogProviderProfileProviderOptionsUpdateCommand,
  CatalogProviderProfileRetirementPlanUpdateCommand,
  CatalogProviderProfileSourceContractUpdateCommand,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationOption,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationScope,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
  SourceObservationReapplyPreview,
} from "./contracts";
import {
  activateSourceObservationProviderProfile,
  bulkPromoteSourceObservationsByScope,
  cloneSourceObservationProviderProfile,
  deprecateSourceObservationProviderProfile,
  dryRunSourceObservationProviderProfile,
  enqueueSourceObservationIntegrationJob,
  previewBulkPromoteSourceObservations,
  previewReapplySourceObservations,
  retireSourceObservationProviderProfile,
  rollbackSourceObservationProviderProfile,
  updateSourceObservationProviderProfile,
  updateSourceObservationProviderProfileSection,
  useActiveSourceObservationIntegrationJobs,
  useSourceObservationProviderProfileAuthoringModel,
  useSourceObservationProviderProfiles,
  useSourceObservationIntegrationOptions,
  watchSourceObservationIntegrationJob,
} from "./use-source-observations";
import { shouldAcceptSourceObservationJobProgress } from "./job-progress";
import {
  MappingExpressionEditor,
  defaultExpression,
  validateMappingExpression,
  type MappingExpressionValue,
} from "./mapping-expression-editor";

const ALL_PROVIDERS = "__all__";
const ALL_LANGUAGES = "__all__";
const ALL_EXPANSIONS = "__all__";
const ALL_SERIES = "__all__";
const TCGDEX_PROVIDER = "tcgdex";
const TCGPLAYER_PROVIDER = "tcgplayer";
const TCGPLAYER_PRODUCT_LINE_SCOPE = "product-line";
const TCGPLAYER_PRODUCT_SCOPE = "product";
const ALL_TCGPLAYER_SETS = "__all_tcgplayer_sets__";
const CATALOG_PROVIDER_CAPABILITY_OPTIONS = [
  "provider-option-query",
  "source-observation-import",
  "catalog-item-promotion",
  "external-reference-extraction",
] as const;
const CATALOG_PROVIDER_SCOPE_OPTIONS = [
  "language",
  "series",
  "expansion",
  "product/card",
  "product-line/category",
  "set-name",
  "product",
  "sku",
] as const;
const REQUIRED_FIXTURE_FLOW_OPTIONS = [
  "normal",
  "partial",
  "stale",
  "changed",
  "ambiguous",
  "replay",
  "sealed-product",
  "unknown-option",
] as const;
const PROFILE_COMPATIBILITY_MODE_OPTIONS = [
  { value: "executable-mapping-contract", label: "Executable mapping contract" },
  { value: "transitional-static-profile", label: "Transitional static profile" },
] satisfies SelectItem[];
const PROFILE_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "planned", label: "Planned" },
] satisfies SelectItem[];
const PROFILE_LIFECYCLE_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "test", label: "Test" },
] satisfies SelectItem[];
const OPTION_QUERY_OPERATION_OPTIONS = [
  { value: "tcgdex-list-languages", label: "TCGdex languages" },
  { value: "tcgdex-list-series", label: "TCGdex series" },
  { value: "tcgdex-list-expansions", label: "TCGdex expansions" },
  { value: "tcgplayer-list-product-lines", label: "TCGplayer product lines" },
  { value: "tcgplayer-list-set-names", label: "TCGplayer set names" },
  { value: "tcgplayer-list-products", label: "TCGplayer products" },
  { value: "tcgplayer-list-skus", label: "TCGplayer SKUs" },
  { value: "scrydex-list-sets", label: "Scrydex sets" },
] satisfies SelectItem[];
const OPTION_QUERY_SCOPE_OPTIONS = [
  { value: "__none__", label: "None" },
  ...CATALOG_PROVIDER_SCOPE_OPTIONS.map((scope) => ({ value: scope, label: scope })),
] satisfies SelectItem[];
const OPTION_QUERY_DESCRIPTION_KIND_OPTIONS = [
  { value: "__none__", label: "None" },
  { value: "path", label: "Path" },
  { value: "tcgdex-expansion-card-count", label: "TCGdex expansion card count" },
  { value: "tcgplayer-set-name", label: "TCGplayer set name" },
] satisfies SelectItem[];
const CONNECTOR_KIND_OPTIONS = [
  { value: "tcgdex-json", label: "TCGdex JSON" },
  { value: "tcgplayer-automation-client", label: "TCGplayer automation client" },
  { value: "scrydex-scryfall-json", label: "Scrydex Scryfall JSON" },
] satisfies SelectItem[];
const NORMALIZED_OUTPUT_KIND_OPTIONS = [
  { value: "pokemon-card", label: "Pokemon card" },
  { value: "provider-product", label: "Provider product" },
] satisfies SelectItem[];

type ProfileBasicsForm = Readonly<{
  displayName: string;
  lifecycle: "draft" | "test";
  status: "active" | "planned";
  compatibilityMode: "executable-mapping-contract" | "transitional-static-profile";
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptionsText: string;
  sourceContract: ProfileSourceContractForm;
  retirementPlan: ProfileRetirementPlanForm;
  optionQueries: readonly ProfileOptionQueryForm[];
  connector: ProfileConnectorForm;
  fixtures: ProfileFixturesForm;
  normalizedObservation: ProfileNormalizedObservationForm;
}>;

type ProfileSourceContractForm = Readonly<{
  owner: string;
  repository: string;
  commit: string;
  documentPath: string;
  fixtureSetVersion: string;
}>;

type ProfileRetirementPlanForm = Readonly<{
  enabled: boolean;
  trackingIssueText: string;
  diagnosticText: string;
}>;

type ProfileOptionQueryForm = Readonly<{
  id: string;
  queryKind: string;
  aliasesText: string;
  displayName: string;
  scope: string;
  parentScope: string;
  parentRequired: boolean;
  parentValueKind: string;
  parentDiagnosticText: string;
  operation: string;
  valuePath: string;
  labelPath: string;
  descriptionKind: string;
  descriptionPath: string;
  parentValuePath: string;
  imageUrlPath: string;
  imageUrlCoalescePathsText: string;
  metadataPathsText: string;
}>;

type ProfileConnectorForm = Readonly<{
  kind: string;
  tcgdexBaseUrl: string;
  tcgdexHighQualityAssetVariant: string;
  tcgdexSeriesListEndpoint: string;
  tcgdexSeriesDetailEndpoint: string;
  tcgdexExpansionListEndpoint: string;
  tcgdexExpansionDetailEndpoint: string;
  tcgdexProductDetailEndpoint: string;
  tcgplayerRepositoryOwner: string;
  tcgplayerRepositoryName: string;
  tcgplayerRepositoryCommit: string;
  tcgplayerSourceContractDocument: string;
  tcgplayerCookieName: string;
  tcgplayerSearchDomain: string;
  tcgplayerMarketplaceApiDomain: string;
  tcgplayerInfiniteApiDomain: string;
  tcgplayerMarketplaceGatewayDomain: string;
  tcgplayerRetryStatusCodesText: string;
  scrydexSourceContractDocument: string;
  scrydexAcceptedEvidenceText: string;
  scrydexExcludedEvidenceText: string;
}>;

type ProfileFixturesForm = Readonly<{
  fixtureRoot: string;
  coveredFlows: readonly string[];
}>;

type ProfileNormalizedObservationForm = Readonly<{
  outputKind: "pokemon-card" | "provider-product";
  profileMapping: Record<string, unknown>;
  languageCode: MappingExpressionValue;
  fields: readonly ProfileExpressionFieldForm[];
  hashMaterial: readonly ProfileExpressionListItemForm[];
  mergeIdentity: readonly ProfileExpressionListItemForm[];
}>;

type ProfileExpressionFieldForm = Readonly<{
  id: string;
  fieldKey: string;
  expression: MappingExpressionValue;
}>;

type ProfileExpressionListItemForm = Readonly<{
  id: string;
  expression: MappingExpressionValue;
}>;

export function IntegrationManagementPage({
  data,
  query,
  profileReviews,
}: CatalogListRouteData<SourceObservationIntegrationScope> & {
  profileReviews?: ListResponse<CatalogProviderProfileVersionReview> | null;
}) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const providerProfiles = useSourceObservationProviderProfiles(profileReviews);
  const [dryRunProfile, setDryRunProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [dryRunFlow, setDryRunFlow] = useState("normal");
  const [dryRunResult, setDryRunResult] = useState<CatalogProviderProfileDryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [profileActionKey, setProfileActionKey] = useState<string | null>(null);
  const [cloneProfile, setCloneProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [cloneProfileVersion, setCloneProfileVersion] = useState(nextProfileVersion());
  const [migrationProfile, setMigrationProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [migrationEvidenceText, setMigrationEvidenceText] = useState("");
  const [editProfile, setEditProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [editBasicsForm, setEditBasicsForm] = useState<ProfileBasicsForm | null>(null);
  const [editProfileError, setEditProfileError] = useState<string | null>(null);
  const [compareProfile, setCompareProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [rollbackProfile, setRollbackProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [retireProfile, setRetireProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [languageCode, setLanguageCode] = useState("en");
  const [seriesId, setSeriesId] = useState("");
  const [importProviderKey, setImportProviderKey] = useState(TCGDEX_PROVIDER);
  const [tcgplayerScopeKind, setTcgplayerScopeKind] = useState(TCGPLAYER_PRODUCT_LINE_SCOPE);
  const [tcgplayerProductLineId, setTcgplayerProductLineId] = useState("");
  const [tcgplayerSetName, setTcgplayerSetName] = useState("");
  const [tcgplayerProductId, setTcgplayerProductId] = useState("");
  const [importing, setImporting] = useState(false);
  const [integrationProgress, setIntegrationProgress] = useState<CatalogBulkActionProgress | null>(null);
  const [showReapply, setShowReapply] = useState(false);
  const [reapplyScope, setReapplyScope] = useState<SourceObservationPromotionScope>({});
  const [reapplyPreview, setReapplyPreview] = useState<SourceObservationReapplyPreview | null>(null);
  const [previewingReapply, setPreviewingReapply] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  const [reapplyProgress, setReapplyProgress] = useState<CatalogBulkActionProgress | null>(null);
  const [showPromoteAll, setShowPromoteAll] = useState(false);
  const [promoteAllScope, setPromoteAllScope] = useState<SourceObservationPromotionScope>({});
  const [promoteAllPreview, setPromoteAllPreview] = useState<SourceObservationPromotionPreview | null>(null);
  const [previewingPromoteAll, setPreviewingPromoteAll] = useState(false);
  const [promoteAllRunning, setPromoteAllRunning] = useState(false);
  const [promoteAllProgress, setPromoteAllProgress] = useState<CatalogBulkActionProgress | null>(null);
  const summary = useMemo(() => summarizeScopes(data.items ?? []), [data.items]);
  const activeIntegrationJobs = useActiveSourceObservationIntegrationJobs();
  const dryRunAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    dryRunProfile?.providerKey ?? "",
    dryRunProfile?.profileVersion ?? "",
    Boolean(dryRunProfile),
  );
  const compareAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    compareProfile?.providerKey ?? "",
    compareProfile?.profileVersion ?? "",
    Boolean(compareProfile),
  );
  const profileColumns = useMemo(
    () =>
      buildProfileColumns({
        onDryRun: openDryRunDialog,
        onClone: openCloneDialog,
        onEditJson: openEditProfileDialog,
        onCompareActive: setCompareProfile,
        onMigrationEvidence: openMigrationEvidenceDialog,
        onActivate: (profile) => void handleActivateProfile(profile),
        onDeprecate: (profile) => void handleDeprecateProfile(profile),
        onRollback: setRollbackProfile,
        onRetire: setRetireProfile,
        busyKey: profileActionKey,
      }),
    [profileActionKey],
  );
  const integrationProviders = useSourceObservationIntegrationOptions({
    providerKey: TCGDEX_PROVIDER,
    queryKind: "providers",
  });
  const columns = useMemo(
    () =>
      buildColumns({
        onPromoteAll: (scope) => void handlePreviewPromoteAll(scope),
        onResync: (scope) => void runIntegrationJob("import", scope),
        onReapply: (scope) => void handlePreviewReapply(scope),
        busy: importing || reapplying || promoteAllRunning || previewingPromoteAll || previewingReapply,
      }),
    [importing, previewingPromoteAll, previewingReapply, promoteAllRunning, reapplying],
  );
  const importLanguages = useSourceObservationIntegrationOptions({
    providerKey: TCGDEX_PROVIDER,
    queryKind: "languages",
  });
  const importSeries = useSourceObservationIntegrationOptions({
    providerKey: TCGDEX_PROVIDER,
    queryKind: "series",
    languageCode,
  });
  const tcgplayerProductLines = useSourceObservationIntegrationOptions({
    providerKey: TCGPLAYER_PROVIDER,
    queryKind: "product-lines",
    enabled: importProviderKey === TCGPLAYER_PROVIDER,
  });
  const tcgplayerSetNames = useSourceObservationIntegrationOptions({
    providerKey: TCGPLAYER_PROVIDER,
    queryKind: "set-names",
    parentValue: tcgplayerProductLineId,
    enabled:
      importProviderKey === TCGPLAYER_PROVIDER &&
      tcgplayerScopeKind === TCGPLAYER_PRODUCT_LINE_SCOPE &&
      positiveIntegerText(tcgplayerProductLineId),
  });
  const filterExpansionLanguage = listControls.language || languageCode || "en";
  const filterExpansions = useSourceObservationIntegrationOptions({
    providerKey: listControls.source || TCGDEX_PROVIDER,
    queryKind: "expansions",
    languageCode: filterExpansionLanguage,
    enabled: !listControls.source || listControls.source === TCGDEX_PROVIDER,
  });
  const languageOptions = useMemo(
    () =>
      (importLanguages.data?.items ?? []).map((item) => ({
        label: formatLanguageCodeLabel(metadataString(item.metadata.languageCode) ?? item.value),
        value: item.value,
      })),
    [importLanguages.data],
  );
  const seriesOptions = useMemo(() => toSelectItems(importSeries.data?.items ?? []), [importSeries.data]);
  const tcgplayerProductLineOptions = useMemo(
    () => toSelectItems(tcgplayerProductLines.data?.items ?? []),
    [tcgplayerProductLines.data],
  );
  const tcgplayerSetNameOptions = useMemo(
    () => toSelectItems(tcgplayerSetNames.data?.items ?? []),
    [tcgplayerSetNames.data],
  );
  const filterExpansionOptions = useMemo(
    () => toSelectItems(filterExpansions.data?.items ?? []),
    [filterExpansions.data],
  );
  const providerOptions = useMemo(
    () =>
      (integrationProviders.data?.items ?? []).map((item) => ({
        label: item.label,
        value: item.value,
      })),
    [integrationProviders.data],
  );
  const importProviderOptions = useMemo(
    () =>
      (providerOptions.length > 0
        ? providerOptions
        : [{ label: t("catalog.features.sourceObservations.ui.integrations.provider.tcgdex"), value: TCGDEX_PROVIDER }]
      ).map((item) => ({
        label: item.label,
        value: item.value,
        icon: item.value === TCGPLAYER_PROVIDER ? "package" : item.value === TCGDEX_PROVIDER ? "cards" : "grid",
      })) satisfies SegmentedControlItem[],
    [providerOptions],
  );

  useEffect(() => {
    if (languageOptions.length > 0 && !languageOptions.some((item) => item.value === languageCode)) {
      setLanguageCode(languageOptions[0].value);
    }
  }, [languageOptions, languageCode]);

  useEffect(() => {
    setSeriesId(ALL_SERIES);
  }, [languageCode]);

  useEffect(() => {
    if (seriesOptions.length === 0) {
      setSeriesId(ALL_SERIES);
      return;
    }

    if (seriesId !== ALL_SERIES && !seriesOptions.some((item) => item.value === seriesId)) {
      setSeriesId(ALL_SERIES);
    }
  }, [seriesOptions, seriesId]);

  useEffect(() => {
    if (
      importProviderKey === TCGPLAYER_PROVIDER &&
      tcgplayerProductLineOptions.length > 0 &&
      !tcgplayerProductLineOptions.some((item) => item.value === tcgplayerProductLineId)
    ) {
      setTcgplayerProductLineId(tcgplayerProductLineOptions[0].value);
    }
  }, [importProviderKey, tcgplayerProductLineId, tcgplayerProductLineOptions]);

  useEffect(() => {
    if (
      tcgplayerSetName &&
      tcgplayerSetNameOptions.length > 0 &&
      !tcgplayerSetNameOptions.some((item) => item.value === tcgplayerSetName)
    ) {
      setTcgplayerSetName("");
    }
  }, [tcgplayerSetName, tcgplayerSetNameOptions]);

  async function handleImport() {
    if (importProviderKey === TCGPLAYER_PROVIDER) {
      await runIntegrationJob("import", tcgplayerImportScope());
      setShowImport(false);
      listControls.setFilters({
        source: TCGPLAYER_PROVIDER,
        language: "en",
        setId: tcgplayerScopeKind === TCGPLAYER_PRODUCT_LINE_SCOPE ? tcgplayerSetName.trim() : "",
      });
      return;
    }

    await runIntegrationJob("import", {
      provider: TCGDEX_PROVIDER,
      language: languageCode,
      seriesId: seriesId === ALL_SERIES ? undefined : seriesId,
    });
    setShowImport(false);
    listControls.setFilters({
      source: TCGDEX_PROVIDER,
      language: languageCode,
      setId: "",
    });
  }

  function openDryRunDialog(profile: CatalogProviderProfileVersionReview) {
    setDryRunProfile(profile);
    setDryRunFlow("normal");
    setDryRunResult(null);
    setDryRunError(null);
  }

  function openCloneDialog(profile: CatalogProviderProfileVersionReview) {
    setCloneProfile(profile);
    setCloneProfileVersion(nextProfileVersion(profile.profileVersion));
  }

  function openMigrationEvidenceDialog(profile: CatalogProviderProfileVersionReview) {
    setMigrationProfile(profile);
    setMigrationEvidenceText(profile.migrationEvidence?.evidenceText ?? "");
  }

  function openEditProfileDialog(profile: CatalogProviderProfileVersionReview) {
    setEditProfile(profile);
    setEditBasicsForm(profileBasicsForm(profile));
    setEditProfileError(null);
  }

  async function handleCloneProfile() {
    if (!cloneProfile) {
      return;
    }
    const key = profileActionIdentity(cloneProfile);
    setProfileActionKey(key);

    try {
      await cloneSourceObservationProviderProfile(cloneProfile.providerKey, cloneProfile.profileVersion, {
        targetProfileVersion: cloneProfileVersion.trim(),
      });
      addToast("Profile version cloned.", "success");
      setCloneProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Profile clone failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleSaveMigrationEvidence() {
    if (!migrationProfile) {
      return;
    }
    const key = profileActionIdentity(migrationProfile);
    setProfileActionKey(key);

    try {
      await updateSourceObservationProviderProfile(migrationProfile.providerKey, migrationProfile.profileVersion, {
        migrationEvidence: {
          evidenceText: migrationEvidenceText.trim(),
          recordedAt: new Date().toISOString(),
        },
      });
      addToast("Migration evidence saved.", "success");
      setMigrationProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Migration evidence save failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleSaveProfileBasics() {
    if (!editProfile || !editBasicsForm) {
      return;
    }
    const key = profileActionIdentity(editProfile);
    setProfileActionKey(key);
    setEditProfileError(null);

    try {
      const command: CatalogProviderProfileBasicsUpdateCommand = {
        section: "basics",
        displayName: editBasicsForm.displayName.trim(),
        lifecycle: editBasicsForm.lifecycle,
        status: editBasicsForm.status,
        compatibilityMode: editBasicsForm.compatibilityMode,
        capabilities: [...editBasicsForm.capabilities],
        supportedScopes: [...editBasicsForm.supportedScopes],
        languageOptions: parseListInput(editBasicsForm.languageOptionsText),
      };
      const sourceContractCommand: CatalogProviderProfileSourceContractUpdateCommand = {
        section: "source-contract",
        sourceContract: {
          owner: editBasicsForm.sourceContract.owner.trim(),
          repository: nullableTrimmedValue(editBasicsForm.sourceContract.repository),
          commit: nullableTrimmedValue(editBasicsForm.sourceContract.commit),
          documentPath: editBasicsForm.sourceContract.documentPath.trim(),
          fixtureSetVersion: editBasicsForm.sourceContract.fixtureSetVersion.trim(),
        },
      };
      const retirementPlanCommand: CatalogProviderProfileRetirementPlanUpdateCommand = {
        section: "retirement-plan",
        retirementPlan: editBasicsForm.retirementPlan.enabled
          ? {
              trackingIssue: Number(editBasicsForm.retirementPlan.trackingIssueText),
              removeAfter: "executable-mapping-contract-activated",
              diagnosticText: editBasicsForm.retirementPlan.diagnosticText.trim(),
            }
          : null,
      };
      const providerOptionsCommand: CatalogProviderProfileProviderOptionsUpdateCommand = {
        section: "provider-options",
        optionQueries: editBasicsForm.optionQueries.map(optionQueryFormToCommand),
      };
      const connectorCommand: CatalogProviderProfileConnectorUpdateCommand = {
        section: "connector",
        connector: connectorFormToCommand(editBasicsForm.connector),
      };
      const fixturesCommand: CatalogProviderProfileFixturesUpdateCommand = {
        section: "fixtures",
        fixtures: {
          fixtureRoot: editBasicsForm.fixtures.fixtureRoot.trim(),
          coveredFlows: [...editBasicsForm.fixtures.coveredFlows],
          liveProviderCallsAllowed: false,
        },
      };
      const normalizedObservationCommand: CatalogProviderProfileNormalizedObservationUpdateCommand = {
        section: "normalized-observation",
        normalizedObservationMapping: normalizedObservationMappingFormToCommand(editBasicsForm.normalizedObservation),
        normalizedObservationContract: normalizedObservationContractFormToCommand(editBasicsForm.normalizedObservation),
      };
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "basics",
        command,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "source-contract",
        sourceContractCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "retirement-plan",
        retirementPlanCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "provider-options",
        providerOptionsCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "connector",
        connectorCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "fixtures",
        fixturesCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "normalized-observation",
        normalizedObservationCommand,
      );
      addToast("Profile basics saved.", "success");
      setEditProfile(null);
      setEditBasicsForm(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Profile basics save failed.";
      setEditProfileError(message);
      addToast(message, "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleRollbackProfile() {
    if (!rollbackProfile) {
      return;
    }
    const key = profileActionIdentity(rollbackProfile);
    setProfileActionKey(key);

    try {
      await rollbackSourceObservationProviderProfile(rollbackProfile.providerKey, rollbackProfile.profileVersion);
      addToast("Profile version rolled back.", "success");
      setRollbackProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Profile rollback failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleRetireProfile() {
    if (!retireProfile) {
      return;
    }
    const key = profileActionIdentity(retireProfile);
    setProfileActionKey(key);

    try {
      await retireSourceObservationProviderProfile(retireProfile.providerKey, retireProfile.profileVersion);
      addToast("Profile version retired.", "success");
      setRetireProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Profile retirement failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleDryRunProfile() {
    if (!dryRunProfile) {
      return;
    }

    setDryRunning(true);
    setDryRunError(null);

    try {
      const payload = selectedDryRunPayload(dryRunAuthoringModel.data, dryRunFlow);
      if (!payload) {
        throw new Error("Select a fixture flow with an available sample payload.");
      }
      const result = await dryRunSourceObservationProviderProfile(
        dryRunProfile.providerKey,
        dryRunProfile.profileVersion,
        payload,
      );
      setDryRunResult(result);
    } catch (error) {
      setDryRunError(
        error instanceof SyntaxError
          ? t("catalog.features.sourceObservations.ui.integrations.profile.review.invalid.json")
          : error instanceof Error
            ? error.message
            : t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run.failed"),
      );
    } finally {
      setDryRunning(false);
    }
  }

  async function handleActivateProfile(profile: CatalogProviderProfileVersionReview) {
    const key = profileActionIdentity(profile);
    setProfileActionKey(key);

    try {
      await activateSourceObservationProviderProfile(profile.providerKey, profile.profileVersion);
      addToast(t("catalog.features.sourceObservations.ui.integrations.profile.review.activated"), "success");
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.profile.review.activate.failed"),
        "danger",
      );
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleDeprecateProfile(profile: CatalogProviderProfileVersionReview) {
    const key = profileActionIdentity(profile);
    setProfileActionKey(key);

    try {
      await deprecateSourceObservationProviderProfile(profile.providerKey, profile.profileVersion);
      addToast(t("catalog.features.sourceObservations.ui.integrations.profile.review.deprecated"), "success");
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.profile.review.deprecate.failed"),
        "danger",
      );
    } finally {
      setProfileActionKey(null);
    }
  }

  function tcgplayerImportScope(): SourceObservationIntegrationJobScope {
    if (tcgplayerScopeKind === TCGPLAYER_PRODUCT_SCOPE) {
      return {
        provider: TCGPLAYER_PROVIDER,
        language: "en",
        productId: tcgplayerProductId.trim(),
      };
    }

    return {
      provider: TCGPLAYER_PROVIDER,
      language: "en",
      productLineId: tcgplayerProductLineId.trim(),
      setName: tcgplayerSetName.trim() || undefined,
    };
  }

  function canImportCurrentScope(): boolean {
    if (importProviderKey === TCGPLAYER_PROVIDER) {
      return tcgplayerScopeKind === TCGPLAYER_PRODUCT_SCOPE
        ? positiveIntegerText(tcgplayerProductId)
        : positiveIntegerText(tcgplayerProductLineId);
    }

    return Boolean(languageCode);
  }

  function currentReapplyScope(): SourceObservationPromotionScope {
    return {
      search: listControls.search,
      provider: listControls.source,
      language: listControls.language,
      setId: listControls.setId,
    };
  }

  async function handlePreviewReapply(scope = currentReapplyScope()) {
    setPreviewingReapply(true);

    try {
      const preview = await previewReapplySourceObservations(scope);
      setReapplyScope(scope);
      setReapplyPreview(preview);
      setShowReapply(true);
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.reapply.failed"),
        "danger",
      );
    } finally {
      setPreviewingReapply(false);
    }
  }

  async function handleReapplyMatching() {
    setReapplying(true);
    setReapplyProgress(null);

    try {
      const result = await runIntegrationJob("reapply", {
        provider: reapplyScope.provider,
        language: reapplyScope.language,
        setId: reapplyScope.setId,
      });
      setShowReapply(false);
      setReapplyPreview(null);
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.reapply.failed"),
        "danger",
      );
    } finally {
      setReapplying(false);
      setReapplyProgress(null);
    }
  }

  async function handlePreviewPromoteAll(scope: SourceObservationPromotionScope) {
    setPreviewingPromoteAll(true);

    try {
      const preview = await previewBulkPromoteSourceObservations(scope);
      setPromoteAllScope(scope);
      setPromoteAllPreview(preview);
      setShowPromoteAll(true);
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setPreviewingPromoteAll(false);
    }
  }

  async function handlePromoteAllMatching() {
    setPromoteAllRunning(true);
    setPromoteAllProgress(null);

    try {
      const result = await bulkPromoteSourceObservationsByScope(promoteAllScope, {
        onProgress: setPromoteAllProgress,
      });
      addToast(
        t("catalog.features.sourceObservations.ui.list.bulk.promote.completed", {
          promoted: String(result.promoted),
          skipped: String(result.skipped),
          failed: String(result.failed),
        }),
        result.failed > 0 ? "warning" : "success",
      );
      setShowPromoteAll(false);
      setPromoteAllPreview(null);
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setPromoteAllRunning(false);
      setPromoteAllProgress(null);
    }
  }

  async function runIntegrationJob(
    action: "import" | "reapply",
    scope: SourceObservationIntegrationJobScope,
  ): Promise<SourceObservationIntegrationJobResult> {
    setImporting(action === "import");
    setIntegrationProgress(queuedProgress());

    try {
      const job = await enqueueSourceObservationIntegrationJob(action, scope);
      const result = await watchSourceObservationIntegrationJob(job.jobId, {
        onProgress: (progress) => {
          setIntegrationProgress((current) =>
            shouldAcceptSourceObservationJobProgress(current, progress) ? progress : current,
          );
          if (action === "reapply") {
            setReapplyProgress((current) =>
              shouldAcceptSourceObservationJobProgress(current, progress) ? progress : current,
            );
          }
        },
      });
      addIntegrationJobCompletionToast(action, result, addToast);
      revalidator.revalidate();
      activeIntegrationJobs.refresh();
      return result;
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.integrations.job.failed"),
        "danger",
      );
      throw error;
    } finally {
      setImporting(false);
      setIntegrationProgress(null);
    }
  }

  return (
    <Page>
      <PageHeader title={t("catalog.features.sourceObservations.ui.integrations.title")} />
      <Stack gap={4}>
        <Stack gap={3}>
          <Inline gap={3} align="center">
            <Stack gap={1}>
              <h2>{t("catalog.features.sourceObservations.ui.integrations.profile.review.title")}</h2>
              <p>{t("catalog.features.sourceObservations.ui.integrations.profile.review.description")}</p>
            </Stack>
            <Button tone="secondary" leadingIcon="refreshCcw" onClick={providerProfiles.refresh}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.refresh")}
            </Button>
          </Inline>
          <DataTable
            rows={providerProfiles.data?.items ?? []}
            columns={profileColumns}
            getRowId={(row) => profileActionIdentity(row)}
            emptyTitle={t("catalog.features.sourceObservations.ui.integrations.profile.review.none.found")}
          />
        </Stack>

        <ActionBar>
          <Button leadingIcon="plus" onClick={() => setShowImport(true)}>
            {t("catalog.features.sourceObservations.ui.integrations.pull.provider.data")}
          </Button>
          <Button
            tone="secondary"
            leadingIcon="badgeCheck"
            loading={previewingReapply}
            disabled={previewingReapply || reapplying || summary.promoted === 0}
            onClick={() => void handlePreviewReapply()}
          >
            {t("catalog.features.sourceObservations.ui.integrations.reapply.promoted")}
          </Button>
        </ActionBar>
        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.scopes")}
            value={formatCount(summary.scopes)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.observations")}
            value={formatCount(summary.total)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.needs.review")}
            value={formatCount(summary.observed + summary.changed)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.promoted")}
            value={formatCount(summary.promoted)}
          />
        </StatGrid>

        <FilterBar sticky={false}>
          <Select
            label={t("catalog.features.sourceObservations.ui.integrations.provider")}
            value={listControls.source || ALL_PROVIDERS}
            onValueChange={(value) =>
              listControls.setFilters({
                source: value === ALL_PROVIDERS ? "" : value,
                setId: "",
              })
            }
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.providers"),
                value: ALL_PROVIDERS,
              },
              ...providerOptions,
            ]}
            error={integrationProviders.error ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.language")}
            value={listControls.language || ALL_LANGUAGES}
            onValueChange={(value) =>
              listControls.setFilters({
                language: value === ALL_LANGUAGES ? "" : value,
                setId: "",
              })
            }
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.list.all.languages"),
                value: ALL_LANGUAGES,
              },
              ...languageOptions,
            ]}
          />
          <Combobox
            label={t("catalog.features.sourceObservations.ui.list.expansion")}
            value={listControls.setId || ALL_EXPANSIONS}
            onValueChange={(value) => listControls.setSetId(value === ALL_EXPANSIONS ? "" : value)}
            placeholder={t("catalog.features.sourceObservations.ui.integrations.all.expansions")}
            noMatchesLabel={t("catalog.features.sourceObservations.ui.integrations.no.expansions.found")}
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.expansions"),
                value: ALL_EXPANSIONS,
              },
              ...withSelectedFallback(filterExpansionOptions, listControls.setId),
            ]}
            disabled={(!!listControls.source && listControls.source !== TCGDEX_PROVIDER) || filterExpansions.loading}
            error={filterExpansions.error ?? undefined}
          />
        </FilterBar>

        <DataTable
          rows={data.items ?? []}
          columns={columns}
          getRowId={(row) => [row.provider_key, row.language_code, row.expansion_id, row.series_id].join(":")}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrations.none.found")}
        />
      </Stack>

      <Dialog
        open={Boolean(dryRunProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setDryRunProfile(null);
            setDryRunResult(null);
            setDryRunError(null);
          }
        }}
        title={
          dryRunProfile
            ? t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run.title.named", {
                provider: dryRunProfile.displayName,
                version: dryRunProfile.profileVersion,
              })
            : t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run.title")
        }
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setDryRunProfile(null)} disabled={dryRunning}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button leadingIcon="play" onClick={handleDryRunProfile} loading={dryRunning}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          {dryRunAuthoringModel.loading ? <p>Loading fixture templates...</p> : null}
          {dryRunAuthoringModel.error ? <p>{dryRunAuthoringModel.error}</p> : null}
          {dryRunAuthoringModel.data ? (
            <Stack gap={3}>
              <Select
                label="Fixture flow"
                value={dryRunFlow}
                onValueChange={setDryRunFlow}
                items={dryRunFixtureItems(dryRunAuthoringModel.data)}
              />
              <DryRunFixtureSummary model={dryRunAuthoringModel.data} flow={dryRunFlow} />
            </Stack>
          ) : null}
          {dryRunError ? <p>{dryRunError}</p> : null}
          {dryRunResult ? <ProfileDryRunResultPanels result={dryRunResult} /> : null}
        </Stack>
      </Dialog>

      <Dialog
        open={Boolean(cloneProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setCloneProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.clone.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setCloneProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="plus"
              onClick={handleCloneProfile}
              disabled={!cloneProfileVersion.trim()}
              loading={Boolean(cloneProfile && profileActionKey === profileActionIdentity(cloneProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.clone")}
            </Button>
          </Inline>
        }
      >
        {cloneProfile ? (
          <Stack gap={4}>
            <KeyValueList
              items={[
                { key: "Provider", value: cloneProfile.displayName },
                {
                  key: t("catalog.features.sourceObservations.ui.integrations.profile.review.source.version"),
                  value: cloneProfile.profileVersion,
                },
              ]}
            />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrations.profile.review.target.profile.version")}
              value={cloneProfileVersion}
              onChange={(event) => setCloneProfileVersion(event.currentTarget.value)}
            />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(migrationProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setMigrationProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.migration.evidence.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setMigrationProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handleSaveMigrationEvidence}
              disabled={!migrationEvidenceText.trim()}
              loading={Boolean(migrationProfile && profileActionKey === profileActionIdentity(migrationProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.save.evidence")}
            </Button>
          </Inline>
        }
      >
        {migrationProfile ? (
          <Stack gap={4}>
            <KeyValueList
              items={[
                { key: "Provider", value: migrationProfile.displayName },
                { key: "Version", value: migrationProfile.profileVersion },
                { key: "Current evidence", value: migrationProfile.migrationEvidence?.evidenceText ?? "None" },
              ]}
            />
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrations.profile.review.evidence")}
              rows={6}
              value={migrationEvidenceText}
              onChange={(event) => setMigrationEvidenceText(event.currentTarget.value)}
            />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(editProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setEditProfile(null);
            setEditBasicsForm(null);
            setEditProfileError(null);
          }
        }}
        title="Edit Profile Basics"
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setEditProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="settings"
              onClick={handleSaveProfileBasics}
              disabled={profileBasicsSaveDisabled(editProfile, editBasicsForm)}
              loading={Boolean(editProfile && profileActionKey === profileActionIdentity(editProfile))}
            >
              Save Basics
            </Button>
          </Inline>
        }
      >
        {editProfile && editBasicsForm ? (
          <ProfileBasicsEditor
            profile={editProfile}
            form={editBasicsForm}
            onChange={setEditBasicsForm}
            error={editProfileError}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(compareProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setCompareProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.compare.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setCompareProfile(null)}>
              {t("catalog.features.sourceObservations.ui.list.close")}
            </Button>
          </Inline>
        }
      >
        {compareProfile ? (
          <Stack gap={3}>
            <KeyValueList
              items={profileComparisonItems(
                compareProfile,
                activeProfileFor(compareProfile, providerProfiles.data?.items ?? []),
              )}
            />
            {compareAuthoringModel.loading ? <p>Loading profile authoring model...</p> : null}
            {compareAuthoringModel.error ? <p>{compareAuthoringModel.error}</p> : null}
            {compareAuthoringModel.data ? <ProfileAuthoringCompare model={compareAuthoringModel.data} /> : null}
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(rollbackProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setRollbackProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setRollbackProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="refreshCcw"
              onClick={handleRollbackProfile}
              loading={Boolean(rollbackProfile && profileActionKey === profileActionIdentity(rollbackProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback.confirm")}
            </Button>
          </Inline>
        }
      >
        {rollbackProfile ? (
          <p>
            {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback.body", {
              provider: rollbackProfile.displayName,
              version: rollbackProfile.profileVersion,
            })}
          </p>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(retireProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setRetireProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.retire.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setRetireProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              tone="danger"
              leadingIcon="trash"
              onClick={handleRetireProfile}
              loading={Boolean(retireProfile && profileActionKey === profileActionIdentity(retireProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire")}
            </Button>
          </Inline>
        }
      >
        {retireProfile ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire.body", {
                provider: retireProfile.displayName,
                version: retireProfile.profileVersion,
              })}
            </p>
            <KeyValueList
              items={[
                {
                  key: t(
                    "catalog.features.sourceObservations.ui.integrations.profile.review.source.observation.references",
                  ),
                  value: String(retireProfile.referenceCount),
                },
              ]}
            />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={showImport}
        onOpenChange={setShowImport}
        title={t("catalog.features.sourceObservations.ui.integrations.pull.provider.data")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowImport(false)} disabled={importing}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              onClick={handleImport}
              loading={importing}
              disabled={
                !canImportCurrentScope() ||
                importing ||
                (importProviderKey === TCGDEX_PROVIDER && (importLanguages.loading || importSeries.loading)) ||
                (importProviderKey === TCGPLAYER_PROVIDER &&
                  tcgplayerScopeKind === TCGPLAYER_PRODUCT_LINE_SCOPE &&
                  (tcgplayerProductLines.loading || tcgplayerSetNames.loading))
              }
            >
              {t("catalog.features.sourceObservations.ui.list.import")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          <SegmentedControl
            aria-label={t("catalog.features.sourceObservations.ui.integrations.provider")}
            value={importProviderKey}
            onValueChange={setImportProviderKey}
            items={importProviderOptions}
            fullWidth
          />
          {importProviderKey === TCGPLAYER_PROVIDER ? (
            <>
              <SegmentedControl
                value={tcgplayerScopeKind}
                onValueChange={setTcgplayerScopeKind}
                items={[
                  {
                    label: t("catalog.features.sourceObservations.ui.integrations.tcgplayer.scope.product.line"),
                    value: TCGPLAYER_PRODUCT_LINE_SCOPE,
                    icon: "grid",
                  },
                  {
                    label: t("catalog.features.sourceObservations.ui.integrations.tcgplayer.scope.product"),
                    value: TCGPLAYER_PRODUCT_SCOPE,
                    icon: "package",
                  },
                ]}
                fullWidth
              />
              {tcgplayerScopeKind === TCGPLAYER_PRODUCT_SCOPE ? (
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrations.tcgplayer.product.id")}
                  value={tcgplayerProductId}
                  onChange={(event) => setTcgplayerProductId(event.target.value)}
                  inputMode="numeric"
                />
              ) : (
                <>
                  <Select
                    label={t("catalog.features.sourceObservations.ui.integrations.tcgplayer.product.line")}
                    value={tcgplayerProductLineId}
                    onValueChange={setTcgplayerProductLineId}
                    items={withSelectedFallback(tcgplayerProductLineOptions, tcgplayerProductLineId)}
                    disabled={tcgplayerProductLines.loading || tcgplayerProductLineOptions.length === 0}
                    error={tcgplayerProductLines.error ?? undefined}
                  />
                  <Select
                    label={t("catalog.features.sourceObservations.ui.integrations.tcgplayer.set.name")}
                    value={tcgplayerSetName || ALL_TCGPLAYER_SETS}
                    onValueChange={(value) => setTcgplayerSetName(value === ALL_TCGPLAYER_SETS ? "" : value)}
                    items={[
                      {
                        label: t("catalog.features.sourceObservations.ui.integrations.all.sets"),
                        value: ALL_TCGPLAYER_SETS,
                      },
                      ...withSelectedFallback(tcgplayerSetNameOptions, tcgplayerSetName),
                    ]}
                    disabled={!positiveIntegerText(tcgplayerProductLineId) || tcgplayerSetNames.loading}
                    error={tcgplayerSetNames.error ?? undefined}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <Select
                label={t("catalog.features.sourceObservations.ui.list.language")}
                value={languageCode}
                onValueChange={setLanguageCode}
                items={languageOptions}
                disabled={importLanguages.loading || languageOptions.length === 0}
                error={importLanguages.error ?? undefined}
              />
              <Select
                label={t("catalog.features.sourceObservations.ui.list.series")}
                value={seriesId}
                onValueChange={setSeriesId}
                items={[
                  {
                    label: t("catalog.features.sourceObservations.ui.integrations.all.series"),
                    value: ALL_SERIES,
                  },
                  ...seriesOptions,
                ]}
                disabled={importSeries.loading || seriesOptions.length === 0}
                error={importSeries.error ?? undefined}
              />
            </>
          )}
          {integrationProgress ? (
            <ProgressBar
              value={bulkActionProgressPercent(integrationProgress)}
              formatLabel={() => formatBulkActionProgress(integrationProgress)}
            />
          ) : null}
        </Stack>
      </Dialog>
      <Dialog
        open={showReapply}
        onOpenChange={setShowReapply}
        title={t("catalog.features.sourceObservations.ui.integrations.reapply.confirm.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowReapply(false)} disabled={reapplying}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handleReapplyMatching}
              disabled={reapplying || !reapplyPreview || reapplyPreview.eligible === 0}
              loading={reapplying}
            >
              {t("catalog.features.sourceObservations.ui.integrations.reapply.confirm")}
            </Button>
          </Inline>
        }
      >
        {reapplyPreview ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.reapply.confirm.body", {
                eligible: String(reapplyPreview.eligible),
                ineligible: String(reapplyPreview.ineligible),
                matched: String(reapplyPreview.matched),
              })}
            </p>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.reapply.confirm.scope", {
                scope: formatReapplyScope(reapplyPreview.scope),
              })}
            </p>
            {reapplyProgress ? (
              <ProgressBar
                value={bulkActionProgressPercent(reapplyProgress)}
                formatLabel={() => formatBulkActionProgress(reapplyProgress)}
              />
            ) : null}
          </Stack>
        ) : null}
      </Dialog>
      <Dialog
        open={showPromoteAll}
        onOpenChange={setShowPromoteAll}
        title={t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowPromoteAll(false)} disabled={promoteAllRunning}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handlePromoteAllMatching}
              disabled={promoteAllRunning || !promoteAllPreview || promoteAllPreview.eligible === 0}
              loading={promoteAllRunning}
            >
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm")}
            </Button>
          </Inline>
        }
      >
        {promoteAllPreview ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.body", {
                eligible: String(promoteAllPreview.eligible),
                terminal: String(promoteAllPreview.terminal),
                matched: String(promoteAllPreview.matched),
              })}
            </p>
            <p>
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.scope", {
                scope: formatReapplyScope(promoteAllPreview.scope),
              })}
            </p>
            {promoteAllProgress ? (
              <ProgressBar
                value={bulkActionProgressPercent(promoteAllProgress)}
                formatLabel={() => formatBulkActionProgress(promoteAllProgress)}
              />
            ) : null}
          </Stack>
        ) : null}
      </Dialog>
    </Page>
  );
}

type IntegrationRowActions = Readonly<{
  onPromoteAll: (scope: SourceObservationPromotionScope) => void;
  onResync: (scope: SourceObservationIntegrationJobScope) => void;
  onReapply: (scope: SourceObservationPromotionScope) => void;
  busy: boolean;
}>;

type ProfileRowActions = Readonly<{
  onDryRun: (profile: CatalogProviderProfileVersionReview) => void;
  onClone: (profile: CatalogProviderProfileVersionReview) => void;
  onEditJson: (profile: CatalogProviderProfileVersionReview) => void;
  onCompareActive: (profile: CatalogProviderProfileVersionReview) => void;
  onMigrationEvidence: (profile: CatalogProviderProfileVersionReview) => void;
  onActivate: (profile: CatalogProviderProfileVersionReview) => void;
  onDeprecate: (profile: CatalogProviderProfileVersionReview) => void;
  onRollback: (profile: CatalogProviderProfileVersionReview) => void;
  onRetire: (profile: CatalogProviderProfileVersionReview) => void;
  busyKey: string | null;
}>;

function buildProfileColumns(actions: ProfileRowActions): DataColumn<CatalogProviderProfileVersionReview>[] {
  return [
    {
      key: "provider",
      header: t("catalog.features.sourceObservations.ui.integrations.provider"),
      cell: (row) => row.displayName,
    },
    {
      key: "version",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.version"),
      cell: (row) => row.profileVersion,
    },
    {
      key: "lifecycle",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.lifecycle"),
      cell: (row) => (
        <Inline gap={2}>
          <StatusPill tone={row.active ? "success" : row.lifecycle === "deprecated" ? "warning" : "neutral"}>
            {row.active
              ? t("catalog.features.sourceObservations.ui.integrations.profile.review.active")
              : row.lifecycle}
          </StatusPill>
          <span>{row.compatibilityMode}</span>
          <span>{row.referenceCount} refs</span>
        </Inline>
      ),
    },
    {
      key: "validation",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.validation"),
      cell: (row) => (
        <Stack gap={1}>
          <StatusPill tone={row.validation.status === "valid" ? "success" : "danger"}>
            {row.validation.status}
          </StatusPill>
          <span>
            {t("catalog.features.sourceObservations.ui.integrations.profile.review.diagnostic.count", {
              count: String(row.validation.diagnostics.length),
            })}
          </span>
        </Stack>
      ),
    },
    {
      key: "fixture",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.fixture"),
      cell: (row) => (
        <Stack gap={1}>
          <span>{row.sourceContract.fixtureSetVersion}</span>
          <span>
            {t("catalog.features.sourceObservations.ui.integrations.profile.review.fixture.flows", {
              count: String(row.fixtures.coveredFlows.length),
            })}
          </span>
        </Stack>
      ),
    },
    {
      key: "mapping",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.mapping"),
      cell: (row) => (
        <Stack gap={1}>
          <span>{row.mappingOutputKind}</span>
          <span>{row.connectorKind}</span>
        </Stack>
      ),
    },
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.scope"),
      cell: (row) => row.supportedScopes.join(", "),
    },
    {
      key: "actions",
      header: "",
      cell: (row) => {
        const busy = actions.busyKey === profileActionIdentity(row);
        return (
          <Inline gap={2} align="end">
            <Button size="sm" tone="secondary" leadingIcon="play" onClick={() => actions.onDryRun(row)}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run")}
            </Button>
            <Button size="sm" tone="secondary" leadingIcon="plus" onClick={() => actions.onClone(row)}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.clone")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="settings"
              disabled={row.lifecycle !== "draft" && row.lifecycle !== "test"}
              onClick={() => actions.onEditJson(row)}
            >
              Edit Profile
            </Button>
            <Button size="sm" tone="secondary" leadingIcon="search" onClick={() => actions.onCompareActive(row)}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.compare")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              onClick={() => actions.onMigrationEvidence(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.evidence")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={busy || row.active || row.validation.status !== "valid"}
              loading={busy && !row.active}
              onClick={() => actions.onActivate(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.activate")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="trash"
              disabled={busy || row.lifecycle === "deprecated"}
              loading={busy && row.lifecycle !== "deprecated"}
              onClick={() => actions.onDeprecate(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.deprecate")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="refreshCcw"
              disabled={busy || row.active || row.lifecycle === "retired"}
              onClick={() => actions.onRollback(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="trash"
              disabled={busy || row.active || row.lifecycle === "retired" || row.referenceCount > 0}
              onClick={() => actions.onRetire(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire")}
            </Button>
          </Inline>
        );
      },
    },
  ];
}

function ProfileAuthoringCompare({ model }: Readonly<{ model: CatalogProviderProfileAuthoringModel }>) {
  const readiness = model.activationReadiness;
  const blockedChecks = readiness.checks.filter((check) => check.status === "blocked");
  const changedDiffs = model.semanticDiff.changes.filter((change) => change.changed);

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Inline gap={2}>
          <StatusPill tone={readiness.status === "ready" ? "success" : "danger"}>
            {readiness.status === "ready" ? "Ready to activate" : "Activation blocked"}
          </StatusPill>
          <StatusPill tone={model.semanticDiff.mappingFingerprint.changed ? "warning" : "success"}>
            {model.semanticDiff.mappingFingerprint.changed ? "Mapping changed" : "Mapping unchanged"}
          </StatusPill>
        </Inline>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            {
              key: "Candidate",
              value: model.semanticDiff.candidateProfileVersion,
            },
            {
              key: "Active",
              value: model.semanticDiff.activeProfileVersion ?? "None",
            },
            {
              key: "Editable sections",
              value: String(model.editableSections.length),
            },
            {
              key: "Fixture templates",
              value: `${model.fixtureCases.filter((fixtureCase) => fixtureCase.samplePayloadAvailable).length}/${model.fixtureCases.length}`,
            },
            {
              key: "Migration evidence",
              value: readiness.requiresMigrationEvidence ? "Required" : "Not required",
            },
          ]}
        />
      </Stack>

      <Stack gap={2}>
        <h3>Activation Readiness</h3>
        <DataTable
          rows={blockedChecks.length > 0 ? blockedChecks : readiness.checks}
          columns={activationReadinessColumns}
          getRowId={(row, index) => `${row.checkKey}:${row.path}:${index}`}
          emptyTitle="No readiness checks"
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>Semantic Changes</h3>
        <DataTable
          rows={changedDiffs.length > 0 ? changedDiffs : model.semanticDiff.changes}
          columns={semanticDiffColumns}
          getRowId={(row) => row.path}
          emptyTitle="No semantic changes"
          density="compact"
        />
      </Stack>
    </Stack>
  );
}

function ProfileBasicsEditor({
  profile,
  form,
  onChange,
  error,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview;
  form: ProfileBasicsForm;
  onChange: (form: ProfileBasicsForm) => void;
  error: string | null;
}>) {
  const setForm = (patch: Partial<ProfileBasicsForm>) => onChange({ ...form, ...patch });
  const setSourceContract = (patch: Partial<ProfileSourceContractForm>) =>
    setForm({ sourceContract: { ...form.sourceContract, ...patch } });
  const setRetirementPlan = (patch: Partial<ProfileRetirementPlanForm>) =>
    setForm({ retirementPlan: { ...form.retirementPlan, ...patch } });
  const setOptionQueries = (optionQueries: readonly ProfileOptionQueryForm[]) => setForm({ optionQueries });
  const setOptionQuery = (id: string, patch: Partial<ProfileOptionQueryForm>) =>
    setOptionQueries(form.optionQueries.map((query) => (query.id === id ? { ...query, ...patch } : query)));
  const setConnector = (patch: Partial<ProfileConnectorForm>) =>
    setForm({ connector: { ...form.connector, ...patch } });
  const setFixtures = (patch: Partial<ProfileFixturesForm>) => setForm({ fixtures: { ...form.fixtures, ...patch } });
  const setNormalizedObservation = (normalizedObservation: ProfileNormalizedObservationForm) =>
    setForm({ normalizedObservation });
  const editable = profileLifecycleEditable(profile);
  const retirementTrackingIssueInvalid =
    form.retirementPlan.enabled && !positiveIntegerText(form.retirementPlan.trackingIssueText);
  const optionQueryDiagnostics = validateOptionQueryForms(form.optionQueries);
  const connectorDiagnostics = validateConnectorForm(form.connector);
  const normalizedObservationDiagnostics = validateNormalizedObservationForm(form.normalizedObservation);
  const missingFixtureFlows = REQUIRED_FIXTURE_FLOW_OPTIONS.filter(
    (flow) => !form.fixtures.coveredFlows.includes(flow),
  );

  return (
    <Stack gap={4}>
      <KeyValueList
        items={[
          { key: "Provider key", value: profile.providerKey },
          { key: "Profile key", value: profile.profileKey },
          { key: "Profile version", value: profile.profileVersion },
          { key: "Lifecycle", value: profile.lifecycle },
          { key: "Active", value: profile.active ? "Yes" : "No" },
          { key: "Created", value: profile.authoringAudit?.createdAt ?? "Not recorded" },
          { key: "Created by", value: profile.authoringAudit?.createdByUserId ?? "Not recorded" },
          { key: "Created for account", value: profile.authoringAudit?.createdForAccountId ?? "Not recorded" },
          { key: "Last updated", value: profile.authoringAudit?.updatedAt ?? "Not recorded" },
          { key: "Updated by", value: profile.authoringAudit?.updatedByUserId ?? "Not recorded" },
          { key: "Updated for account", value: profile.authoringAudit?.updatedForAccountId ?? "Not recorded" },
          { key: "Migration evidence recorded", value: profile.migrationEvidence?.recordedAt ?? "Not recorded" },
          { key: "Migration evidence by", value: profile.migrationEvidence?.recordedByUserId ?? "Not recorded" },
          {
            key: "Migration evidence account",
            value: profile.migrationEvidence?.recordedForAccountId ?? "Not recorded",
          },
        ]}
      />

      {!editable ? (
        <p className="text-sm text-secondary">
          This profile version is immutable from the Basics editor. Use the lifecycle actions on the profile row to
          deprecate, roll back, or retire it.
        </p>
      ) : null}

      <TextInput
        label="Display name"
        value={form.displayName}
        disabled={!editable}
        onChange={(event) => setForm({ displayName: event.currentTarget.value })}
      />

      <Inline gap={3}>
        <Select
          label="Lifecycle"
          value={form.lifecycle}
          onValueChange={(value) => setForm({ lifecycle: value === "test" ? "test" : "draft" })}
          items={PROFILE_LIFECYCLE_OPTIONS}
          disabled={!editable}
        />
        <Select
          label="Status"
          value={form.status}
          onValueChange={(value) => setForm({ status: value === "active" ? "active" : "planned" })}
          items={PROFILE_STATUS_OPTIONS}
          disabled={!editable}
        />
        <Select
          label="Compatibility"
          value={form.compatibilityMode}
          onValueChange={(value) =>
            setForm({
              compatibilityMode:
                value === "transitional-static-profile" ? "transitional-static-profile" : "executable-mapping-contract",
            })
          }
          items={PROFILE_COMPATIBILITY_MODE_OPTIONS}
          disabled={!editable}
        />
      </Inline>

      <CheckboxSet
        legend="Capabilities"
        options={CATALOG_PROVIDER_CAPABILITY_OPTIONS}
        selected={form.capabilities}
        onChange={(capabilities) => setForm({ capabilities })}
        disabled={!editable}
      />

      <CheckboxSet
        legend="Supported scopes"
        options={CATALOG_PROVIDER_SCOPE_OPTIONS}
        selected={form.supportedScopes}
        onChange={(supportedScopes) => setForm({ supportedScopes })}
        disabled={!editable}
      />

      <Textarea
        label="Language options"
        description="Comma or line separated language codes."
        value={form.languageOptionsText}
        disabled={!editable}
        onChange={(event) => setForm({ languageOptionsText: event.currentTarget.value })}
        rows={4}
      />

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">Source Contract</h3>
        <Inline gap={3}>
          <TextInput
            label="Contract owner"
            value={form.sourceContract.owner}
            disabled={!editable}
            required
            onChange={(event) => setSourceContract({ owner: event.currentTarget.value })}
          />
          <TextInput
            label="Repository"
            value={form.sourceContract.repository}
            disabled={!editable}
            onChange={(event) => setSourceContract({ repository: event.currentTarget.value })}
          />
          <TextInput
            label="Commit"
            value={form.sourceContract.commit}
            disabled={!editable}
            onChange={(event) => setSourceContract({ commit: event.currentTarget.value })}
          />
        </Inline>
        <Inline gap={3}>
          <TextInput
            label="Document path"
            value={form.sourceContract.documentPath}
            disabled={!editable}
            required
            onChange={(event) => setSourceContract({ documentPath: event.currentTarget.value })}
          />
          <TextInput
            label="Fixture set version"
            value={form.sourceContract.fixtureSetVersion}
            disabled={!editable}
            required
            onChange={(event) => setSourceContract({ fixtureSetVersion: event.currentTarget.value })}
          />
        </Inline>
      </Stack>

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">Retirement Plan</h3>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={form.retirementPlan.enabled}
            disabled={!editable}
            onChange={() => setRetirementPlan({ enabled: !form.retirementPlan.enabled })}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          <span>Track planned retirement</span>
        </label>
        {form.retirementPlan.enabled ? (
          <Inline gap={3}>
            <TextInput
              label="Tracking issue"
              value={form.retirementPlan.trackingIssueText}
              disabled={!editable}
              inputMode="numeric"
              error={retirementTrackingIssueInvalid ? "Enter a positive issue number." : undefined}
              onChange={(event) => setRetirementPlan({ trackingIssueText: event.currentTarget.value })}
            />
            <Select
              label="Remove after"
              value="executable-mapping-contract-activated"
              disabled
              items={[
                { value: "executable-mapping-contract-activated", label: "Executable mapping contract activated" },
              ]}
            />
          </Inline>
        ) : null}
        {form.retirementPlan.enabled ? (
          <Textarea
            label="Retirement diagnostic"
            value={form.retirementPlan.diagnosticText}
            disabled={!editable}
            required
            onChange={(event) => setRetirementPlan({ diagnosticText: event.currentTarget.value })}
            rows={3}
          />
        ) : null}
      </Stack>

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">Connector</h3>
        {connectorDiagnostics.length > 0 ? (
          <ul className="text-sm text-danger">
            {connectorDiagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        ) : null}
        <Select
          label="Connector kind"
          value={form.connector.kind}
          disabled={!editable}
          items={CONNECTOR_KIND_OPTIONS}
          onValueChange={(value) => setConnector({ kind: value })}
        />
        {form.connector.kind === "tcgdex-json" ? (
          <Stack gap={3}>
            <Inline gap={3}>
              <TextInput
                label="Base URL"
                value={form.connector.tcgdexBaseUrl}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexBaseUrl: event.currentTarget.value })}
              />
              <TextInput
                label="High quality asset variant"
                value={form.connector.tcgdexHighQualityAssetVariant}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexHighQualityAssetVariant: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label="Series list endpoint"
                value={form.connector.tcgdexSeriesListEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexSeriesListEndpoint: event.currentTarget.value })}
              />
              <TextInput
                label="Series detail endpoint"
                value={form.connector.tcgdexSeriesDetailEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexSeriesDetailEndpoint: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label="Expansion list endpoint"
                value={form.connector.tcgdexExpansionListEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexExpansionListEndpoint: event.currentTarget.value })}
              />
              <TextInput
                label="Expansion detail endpoint"
                value={form.connector.tcgdexExpansionDetailEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexExpansionDetailEndpoint: event.currentTarget.value })}
              />
              <TextInput
                label="Product detail endpoint"
                value={form.connector.tcgdexProductDetailEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexProductDetailEndpoint: event.currentTarget.value })}
              />
            </Inline>
          </Stack>
        ) : null}
        {form.connector.kind === "tcgplayer-automation-client" ? (
          <Stack gap={3}>
            <Inline gap={3}>
              <TextInput
                label="Repository owner"
                value={form.connector.tcgplayerRepositoryOwner}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerRepositoryOwner: event.currentTarget.value })}
              />
              <TextInput
                label="Repository name"
                value={form.connector.tcgplayerRepositoryName}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerRepositoryName: event.currentTarget.value })}
              />
              <TextInput
                label="Repository commit"
                value={form.connector.tcgplayerRepositoryCommit}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerRepositoryCommit: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label="Source contract document"
                value={form.connector.tcgplayerSourceContractDocument}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerSourceContractDocument: event.currentTarget.value })}
              />
              <TextInput
                label="Cookie name"
                value={form.connector.tcgplayerCookieName}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerCookieName: event.currentTarget.value })}
              />
              <TextInput
                label="Retry status codes"
                value={form.connector.tcgplayerRetryStatusCodesText}
                disabled={!editable}
                onChange={(event) => setConnector({ tcgplayerRetryStatusCodesText: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label="Search domain"
                value={form.connector.tcgplayerSearchDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerSearchDomain: event.currentTarget.value })}
              />
              <TextInput
                label="Marketplace API domain"
                value={form.connector.tcgplayerMarketplaceApiDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerMarketplaceApiDomain: event.currentTarget.value })}
              />
              <TextInput
                label="Infinite API domain"
                value={form.connector.tcgplayerInfiniteApiDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerInfiniteApiDomain: event.currentTarget.value })}
              />
              <TextInput
                label="Marketplace gateway domain"
                value={form.connector.tcgplayerMarketplaceGatewayDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerMarketplaceGatewayDomain: event.currentTarget.value })}
              />
            </Inline>
          </Stack>
        ) : null}
        {form.connector.kind === "scrydex-scryfall-json" ? (
          <Stack gap={3}>
            <TextInput
              label="Scrydex contract document"
              value={form.connector.scrydexSourceContractDocument}
              disabled={!editable}
              required
              onChange={(event) => setConnector({ scrydexSourceContractDocument: event.currentTarget.value })}
            />
            <KeyValueList items={[{ key: "Fixture backed only", value: "Yes" }]} />
            <Textarea
              label="Accepted evidence"
              description="Comma or line separated evidence keys."
              value={form.connector.scrydexAcceptedEvidenceText}
              disabled={!editable}
              rows={3}
              onChange={(event) => setConnector({ scrydexAcceptedEvidenceText: event.currentTarget.value })}
            />
            <Textarea
              label="Excluded evidence"
              description="Comma or line separated evidence keys."
              value={form.connector.scrydexExcludedEvidenceText}
              disabled={!editable}
              rows={3}
              onChange={(event) => setConnector({ scrydexExcludedEvidenceText: event.currentTarget.value })}
            />
          </Stack>
        ) : null}
      </Stack>

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">Fixtures</h3>
        <TextInput
          label="Fixture root"
          value={form.fixtures.fixtureRoot}
          disabled={!editable}
          required
          onChange={(event) => setFixtures({ fixtureRoot: event.currentTarget.value })}
        />
        <KeyValueList items={[{ key: "Live provider calls allowed", value: "No" }]} />
        {missingFixtureFlows.length > 0 ? (
          <p className="text-sm text-danger">Missing required fixture flows: {missingFixtureFlows.join(", ")}</p>
        ) : null}
        <CheckboxSet
          legend="Covered fixture flows"
          options={REQUIRED_FIXTURE_FLOW_OPTIONS}
          selected={form.fixtures.coveredFlows}
          disabled={!editable}
          onChange={(coveredFlows) => setFixtures({ coveredFlows })}
        />
      </Stack>

      <NormalizedObservationEditor
        form={form.normalizedObservation}
        onChange={setNormalizedObservation}
        diagnostics={normalizedObservationDiagnostics}
        editable={editable}
      />

      <Stack gap={3}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Provider Options</h3>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="plus"
            disabled={!editable}
            onClick={() => setOptionQueries([...form.optionQueries, emptyOptionQueryForm()])}
          >
            Add query
          </Button>
        </div>
        {optionQueryDiagnostics.length > 0 ? (
          <ul className="text-sm text-danger">
            {optionQueryDiagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        ) : null}
        <Stack gap={4}>
          {form.optionQueries.map((query, index) => (
            <Stack key={query.id} gap={3}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {query.displayName.trim() || query.queryKind.trim() || `Option Query ${index + 1}`}
                </h4>
                <Inline gap={2}>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={!editable || index === 0}
                    onClick={() => setOptionQueries(moveItem(form.optionQueries, index, index - 1))}
                  >
                    Up
                  </Button>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={!editable || index === form.optionQueries.length - 1}
                    onClick={() => setOptionQueries(moveItem(form.optionQueries, index, index + 1))}
                  >
                    Down
                  </Button>
                  <Button
                    size="sm"
                    tone="danger"
                    disabled={!editable}
                    onClick={() =>
                      setOptionQueries(form.optionQueries.filter((candidate) => candidate.id !== query.id))
                    }
                  >
                    Remove
                  </Button>
                </Inline>
              </div>
              <Inline gap={3}>
                <TextInput
                  label="Query kind"
                  value={query.queryKind}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { queryKind: event.currentTarget.value })}
                />
                <TextInput
                  label="Aliases"
                  description="Comma or line separated."
                  value={query.aliasesText}
                  disabled={!editable}
                  onChange={(event) => setOptionQuery(query.id, { aliasesText: event.currentTarget.value })}
                />
                <TextInput
                  label="Option display name"
                  value={query.displayName}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { displayName: event.currentTarget.value })}
                />
              </Inline>
              <Inline gap={3}>
                <Select
                  label="Scope"
                  value={query.scope}
                  disabled={!editable}
                  items={OPTION_QUERY_SCOPE_OPTIONS.filter((item) => item.value !== "__none__")}
                  onValueChange={(value) => setOptionQuery(query.id, { scope: value })}
                />
                <Select
                  label="Parent scope"
                  value={query.parentScope}
                  disabled={!editable}
                  items={OPTION_QUERY_SCOPE_OPTIONS}
                  onValueChange={(value) =>
                    setOptionQuery(query.id, {
                      parentScope: value,
                      parentRequired: value === "__none__" ? false : query.parentRequired,
                    })
                  }
                />
                <Select
                  label="Operation"
                  value={query.operation}
                  disabled={!editable}
                  items={OPTION_QUERY_OPERATION_OPTIONS}
                  onValueChange={(value) => setOptionQuery(query.id, { operation: value })}
                />
              </Inline>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={query.parentRequired}
                  disabled={!editable || query.parentScope === "__none__"}
                  onChange={() => setOptionQuery(query.id, { parentRequired: !query.parentRequired })}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                <span>Parent value required</span>
              </label>
              {query.parentScope !== "__none__" ? (
                <Inline gap={3}>
                  <TextInput
                    label="Parent value kind"
                    value={query.parentValueKind}
                    disabled={!editable}
                    onChange={(event) => setOptionQuery(query.id, { parentValueKind: event.currentTarget.value })}
                  />
                  <TextInput
                    label="Parent diagnostic"
                    value={query.parentDiagnosticText}
                    disabled={!editable}
                    onChange={(event) => setOptionQuery(query.id, { parentDiagnosticText: event.currentTarget.value })}
                  />
                </Inline>
              ) : null}
              <Inline gap={3}>
                <TextInput
                  label="Value path"
                  value={query.valuePath}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { valuePath: event.currentTarget.value })}
                />
                <TextInput
                  label="Label path"
                  value={query.labelPath}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { labelPath: event.currentTarget.value })}
                />
                <TextInput
                  label="Parent value path"
                  value={query.parentValuePath}
                  disabled={!editable}
                  onChange={(event) => setOptionQuery(query.id, { parentValuePath: event.currentTarget.value })}
                />
              </Inline>
              <Inline gap={3}>
                <Select
                  label="Description"
                  value={query.descriptionKind}
                  disabled={!editable}
                  items={OPTION_QUERY_DESCRIPTION_KIND_OPTIONS}
                  onValueChange={(value) => setOptionQuery(query.id, { descriptionKind: value })}
                />
                {query.descriptionKind === "path" ? (
                  <TextInput
                    label="Description path"
                    value={query.descriptionPath}
                    disabled={!editable}
                    onChange={(event) => setOptionQuery(query.id, { descriptionPath: event.currentTarget.value })}
                  />
                ) : null}
                <TextInput
                  label="Image URL path"
                  value={query.imageUrlPath}
                  disabled={!editable}
                  onChange={(event) => setOptionQuery(query.id, { imageUrlPath: event.currentTarget.value })}
                />
              </Inline>
              <Textarea
                label="Image URL coalesce paths"
                description="Comma or line separated paths."
                value={query.imageUrlCoalescePathsText}
                disabled={!editable}
                rows={2}
                onChange={(event) => setOptionQuery(query.id, { imageUrlCoalescePathsText: event.currentTarget.value })}
              />
              <Textarea
                label="Metadata paths"
                description="One key=path mapping per line."
                value={query.metadataPathsText}
                disabled={!editable}
                rows={4}
                onChange={(event) => setOptionQuery(query.id, { metadataPathsText: event.currentTarget.value })}
              />
            </Stack>
          ))}
        </Stack>
      </Stack>

      {profile.validation.diagnostics.length > 0 ? (
        <DataTable
          rows={profile.validation.diagnostics}
          columns={profileValidationColumns}
          getRowId={(row, index) => `${row.path}:${index}`}
          emptyTitle="No validation diagnostics"
          density="compact"
        />
      ) : null}
      {error ? <p>{error}</p> : null}
    </Stack>
  );
}

function NormalizedObservationEditor({
  form,
  onChange,
  diagnostics,
  editable,
}: Readonly<{
  form: ProfileNormalizedObservationForm;
  onChange: (form: ProfileNormalizedObservationForm) => void;
  diagnostics: readonly string[];
  editable: boolean;
}>) {
  const setForm = (patch: Partial<ProfileNormalizedObservationForm>) => onChange({ ...form, ...patch });
  const setField = (id: string, patch: Partial<ProfileExpressionFieldForm>) =>
    setForm({ fields: form.fields.map((field) => (field.id === id ? { ...field, ...patch } : field)) });
  const setHashMaterial = (items: readonly ProfileExpressionListItemForm[]) => setForm({ hashMaterial: items });
  const setMergeIdentity = (items: readonly ProfileExpressionListItemForm[]) => setForm({ mergeIdentity: items });

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Normalized Observation</h3>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ fields: [...form.fields, emptyExpressionFieldForm()] })}
        >
          Add field
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <Select
        label="Normalized output kind"
        value={form.outputKind}
        disabled={!editable}
        items={NORMALIZED_OUTPUT_KIND_OPTIONS}
        onValueChange={(value) =>
          setForm({ outputKind: value === "pokemon-card" ? "pokemon-card" : "provider-product" })
        }
      />
      <MappingExpressionEditor
        label="Language expression"
        value={form.languageCode}
        onChange={(languageCode) => setForm({ languageCode })}
      />
      <Stack gap={4}>
        {form.fields.map((field, index) => (
          <Stack key={field.id} gap={3}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">
                {field.fieldKey.trim() || `Normalized Field ${index + 1}`}
              </h4>
              <Inline gap={2}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === 0}
                  onClick={() => setForm({ fields: moveItem(form.fields, index, index - 1) })}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === form.fields.length - 1}
                  onClick={() => setForm({ fields: moveItem(form.fields, index, index + 1) })}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable}
                  onClick={() =>
                    setForm({
                      fields: insertItem(form.fields, index + 1, {
                        ...field,
                        id: newFormRowId("field"),
                        fieldKey: `${field.fieldKey}Copy`,
                      }),
                    })
                  }
                >
                  Duplicate
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() => setForm({ fields: form.fields.filter((candidate) => candidate.id !== field.id) })}
                >
                  Remove
                </Button>
              </Inline>
            </div>
            <TextInput
              label="Normalized field key"
              value={field.fieldKey}
              disabled={!editable}
              required
              onChange={(event) => setField(field.id, { fieldKey: event.currentTarget.value })}
            />
            <MappingExpressionEditor
              label={`Field expression: ${field.fieldKey.trim() || index + 1}`}
              value={field.expression}
              onChange={(expression) => setField(field.id, { expression })}
            />
          </Stack>
        ))}
      </Stack>
      <NormalizedExpressionListEditor
        title="Hash Material"
        addLabel="Add hash expression"
        items={form.hashMaterial}
        onChange={setHashMaterial}
        editable={editable}
      />
      <NormalizedExpressionListEditor
        title="Merge Identity"
        addLabel="Add merge expression"
        items={form.mergeIdentity}
        onChange={setMergeIdentity}
        editable={editable}
      />
    </Stack>
  );
}

function NormalizedExpressionListEditor({
  title,
  addLabel,
  items,
  onChange,
  editable,
}: Readonly<{
  title: string;
  addLabel: string;
  items: readonly ProfileExpressionListItemForm[];
  onChange: (items: readonly ProfileExpressionListItemForm[]) => void;
  editable: boolean;
}>) {
  const setExpression = (id: string, expression: MappingExpressionValue) =>
    onChange(items.map((item) => (item.id === id ? { ...item, expression } : item)));

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => onChange([...items, emptyExpressionListItemForm()])}
        >
          {addLabel}
        </Button>
      </div>
      {items.length === 0 ? <p className="text-sm text-danger">{title} needs at least one expression.</p> : null}
      {items.map((item, index) => (
        <Stack key={item.id} gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h5 className="text-sm font-semibold text-foreground">
              {title} Expression {index + 1}
            </h5>
            <Inline gap={2}>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === 0}
                onClick={() => onChange(moveItem(items, index, index - 1))}
              >
                Up
              </Button>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === items.length - 1}
                onClick={() => onChange(moveItem(items, index, index + 1))}
              >
                Down
              </Button>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable}
                onClick={() =>
                  onChange(insertItem(items, index + 1, { ...item, id: newFormRowId(title.toLowerCase()) }))
                }
              >
                Duplicate
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={!editable}
                onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))}
              >
                Remove
              </Button>
            </Inline>
          </div>
          <MappingExpressionEditor
            label={`${title} expression ${index + 1}`}
            value={item.expression}
            onChange={(expression) => setExpression(item.id, expression)}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function CheckboxSet({
  legend,
  options,
  selected,
  onChange,
  disabled = false,
}: Readonly<{
  legend: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
  disabled?: boolean;
}>) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-foreground">{legend}</legend>
      <div className="grid gap-2 md:grid-cols-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              disabled={disabled}
              onChange={() => onChange(toggleStringSelection(selected, option))}
              className="h-4 w-4 rounded border-border accent-accent"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function DryRunFixtureSummary({
  model,
  flow,
}: Readonly<{ model: CatalogProviderProfileAuthoringModel; flow: string }>) {
  const fixture = selectedDryRunFixture(model, flow);
  if (!fixture) {
    return <p>No fixture template is available for this flow.</p>;
  }

  return (
    <KeyValueList
      density="compact"
      variant="plain"
      items={[
        { key: "Payload file", value: fixture.payloadFile },
        { key: "Expected status", value: fixture.expectedStatus },
        { key: "Sample payload", value: fixture.samplePayloadAvailable ? "Available" : "Missing" },
        { key: "Expected hash evidence", value: String(fixture.expectedHashEvidencePaths.length) },
        { key: "Expected merge evidence", value: String(fixture.expectedMergeEvidencePaths.length) },
        { key: "Expected commands", value: String(fixture.expectedPromotionCommands.length) },
      ]}
    />
  );
}

function ProfileDryRunResultPanels({ result }: Readonly<{ result: CatalogProviderProfileDryRunResult }>) {
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <h3>Dry-Run Summary</h3>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            { key: "Status", value: result.status },
            { key: "External key", value: result.observation?.externalKey ?? "None" },
            { key: "Source hash", value: result.observation?.sourceRecordHash ?? "None" },
            { key: "Normalized kind", value: result.observation?.normalized.kind ?? "None" },
            { key: "Redacted payload", value: summarizeJsonValue(result.redactedPayload) },
            { key: "Diagnostics", value: String(result.diagnostics.length) },
          ]}
        />
      </Stack>

      <Stack gap={2}>
        <h3>Diagnostics</h3>
        <DataTable
          rows={result.diagnostics}
          columns={dryRunDiagnosticColumns}
          getRowId={(row, index) => `${row.path}:${index}`}
          emptyTitle="No diagnostics"
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>Mapping Evidence</h3>
        <DataTable
          rows={[...result.hashMaterial, ...result.mergeCandidateEvidence]}
          columns={dryRunEvidenceColumns}
          getRowId={(row) => row.path}
          emptyTitle="No mapping evidence"
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>External References</h3>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            {
              key: "Catalog item references",
              value: summarizeJsonValue(result.externalReferences.catalogItemReferences),
            },
            {
              key: "Product references",
              value: summarizeJsonValue(result.externalReferences.productReferences),
            },
            {
              key: "Selected options",
              value: summarizeJsonValue(result.selectedOptions),
            },
          ]}
        />
      </Stack>

      <Stack gap={2}>
        <h3>Duplicate Prevention</h3>
        <DataTable
          rows={result.duplicatePreventionRules}
          columns={dryRunDuplicatePreventionColumns}
          getRowId={(row) => row.ruleKey}
          emptyTitle="No duplicate-prevention decisions"
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>Promotion Command Plan</h3>
        <DataTable
          rows={result.promotionCommandPlan.commands}
          columns={dryRunPromotionCommandColumns}
          getRowId={(row, index) => `${row.commandName}:${index}`}
          emptyTitle="No promotion commands"
          density="compact"
        />
      </Stack>
    </Stack>
  );
}

const activationReadinessColumns: DataColumn<
  CatalogProviderProfileAuthoringModel["activationReadiness"]["checks"][number]
>[] = [
  {
    key: "status",
    header: "Status",
    cell: (row) => (
      <StatusPill tone={row.status === "passed" ? "success" : "danger"}>
        {row.status === "passed" ? "Passed" : "Blocked"}
      </StatusPill>
    ),
  },
  {
    key: "check",
    header: "Check",
    cell: (row) => row.checkKey,
  },
  {
    key: "path",
    header: "Path",
    cell: (row) => row.path,
  },
  {
    key: "detail",
    header: "Detail",
    cell: (row) => row.diagnosticText,
  },
];

const semanticDiffColumns: DataColumn<CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]>[] = [
  {
    key: "change",
    header: "Change",
    cell: (row) => (
      <Stack gap={1}>
        <span>{row.label}</span>
        <StatusPill tone={row.changed ? "warning" : "success"}>{row.changed ? "Changed" : "Unchanged"}</StatusPill>
      </Stack>
    ),
  },
  {
    key: "candidate",
    header: "Candidate",
    cell: (row) => summarizeDiffValue(row.candidate),
  },
  {
    key: "active",
    header: "Active",
    cell: (row) => summarizeDiffValue(row.active),
  },
];

const profileValidationColumns: DataColumn<CatalogProviderProfileVersionReview["validation"]["diagnostics"][number]>[] =
  [
    {
      key: "path",
      header: "Path",
      cell: (row) => row.path,
    },
    {
      key: "severity",
      header: "Severity",
      cell: (row) => <StatusPill tone={row.severity === "error" ? "danger" : "warning"}>{row.severity}</StatusPill>,
    },
    {
      key: "detail",
      header: "Detail",
      cell: (row) => row.diagnosticText,
    },
  ];

const dryRunDiagnosticColumns: DataColumn<CatalogProviderProfileDryRunResult["diagnostics"][number]>[] = [
  {
    key: "path",
    header: "Path",
    cell: (row) => row.path,
  },
  {
    key: "code",
    header: "Code",
    cell: (row) => row.code,
  },
  {
    key: "detail",
    header: "Detail",
    cell: (row) => row.diagnosticText,
  },
];

const dryRunEvidenceColumns: DataColumn<CatalogProviderProfileDryRunResult["hashMaterial"][number]>[] = [
  {
    key: "path",
    header: "Path",
    cell: (row) => row.path,
  },
  {
    key: "owner",
    header: "Owner",
    cell: (row) => row.owner,
  },
  {
    key: "uses",
    header: "Uses",
    cell: (row) => row.uses.join(", "),
  },
  {
    key: "redaction",
    header: "Redaction",
    cell: (row) => row.redaction,
  },
  {
    key: "value",
    header: "Value",
    cell: (row) => summarizeJsonValue(row.value),
  },
];

const dryRunDuplicatePreventionColumns: DataColumn<
  CatalogProviderProfileDryRunResult["duplicatePreventionRules"][number]
>[] = [
  {
    key: "rule",
    header: "Rule",
    cell: (row) => row.ruleKey,
  },
  {
    key: "kind",
    header: "Kind",
    cell: (row) => row.ruleKind,
  },
  {
    key: "policy",
    header: "Policy",
    cell: (row) => row.candidatePolicy,
  },
  {
    key: "evidence",
    header: "Evidence",
    cell: (row) => String(row.evidence.length),
  },
];

const dryRunPromotionCommandColumns: DataColumn<
  CatalogProviderProfileDryRunResult["promotionCommandPlan"]["commands"][number]
>[] = [
  {
    key: "command",
    header: "Command",
    cell: (row) => row.commandName,
  },
  {
    key: "inputs",
    header: "Inputs",
    cell: (row) => String(row.inputs.length),
  },
];

function buildColumns(actions: IntegrationRowActions): DataColumn<SourceObservationIntegrationScope>[] {
  return [
    {
      key: "provider",
      header: t("catalog.features.sourceObservations.ui.integrations.provider"),
      cell: (row) => row.provider_key,
    },
    {
      key: "language",
      header: t("catalog.features.sourceObservations.ui.list.language"),
      cell: (row) => formatLanguageCodeLabel(row.language_code),
    },
    {
      key: "expansion",
      header: t("catalog.features.sourceObservations.ui.list.expansion"),
      cell: (row) => row.expansion_name || row.expansion_id,
    },
    {
      key: "series",
      header: t("catalog.features.sourceObservations.ui.integrations.series"),
      cell: (row) => row.series_name || row.series_id || row.product_line_name || "",
    },
    {
      key: "observed",
      header: t("catalog.features.sourceObservations.ui.integrations.needs.review"),
      cell: (row) => formatCount(reviewableObservationCount(row)),
    },
    {
      key: "promoted",
      header: t("catalog.features.sourceObservations.ui.integrations.promoted"),
      cell: (row) => formatCount(row.promoted_observations),
    },
    {
      key: "rejected",
      header: t("catalog.features.sourceObservations.ui.integrations.rejected"),
      cell: (row) => formatCount(row.rejected_observations),
    },
    {
      key: "latest",
      header: t("catalog.features.sourceObservations.ui.integrations.last.observed"),
      cell: (row) => formatDateTime(row.latest_observed_at),
    },
    {
      key: "review",
      header: "",
      cell: (row) => (
        <Inline gap={2} align="end">
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="badgeCheck"
            disabled={actions.busy || reviewableObservationCount(row) === 0}
            onClick={() => actions.onPromoteAll(rowPromotionScope(row))}
          >
            {t("catalog.features.sourceObservations.ui.integrations.promote.all")}
          </Button>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="refreshCcw"
            disabled={actions.busy}
            onClick={() => actions.onResync(rowIntegrationScope(row))}
          >
            {t("catalog.features.sourceObservations.ui.integrations.resync.set")}
          </Button>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="badgeCheck"
            disabled={actions.busy || row.promoted_observations === 0}
            onClick={() => actions.onReapply(rowPromotionScope(row))}
          >
            {t("catalog.features.sourceObservations.ui.integrations.sync.promoted")}
          </Button>
          <LinkButton href={sourceObservationScopeHref(row)} size="sm" tone="secondary">
            {t("catalog.features.sourceObservations.ui.integrations.review")}
          </LinkButton>
        </Inline>
      ),
    },
  ];
}

function rowPromotionScope(scope: SourceObservationIntegrationScope): SourceObservationPromotionScope {
  return {
    provider: scope.provider_key,
    language: scope.language_code,
    setId: scope.expansion_id,
  };
}

function rowIntegrationScope(scope: SourceObservationIntegrationScope): SourceObservationIntegrationJobScope {
  if (scope.provider_key === TCGPLAYER_PROVIDER) {
    return {
      provider: scope.provider_key,
      language: scope.language_code,
      productLineId: scope.product_line_id || undefined,
      setName: scope.expansion_name || scope.expansion_id || undefined,
    };
  }

  return {
    provider: scope.provider_key,
    language: scope.language_code,
    setId: scope.expansion_id,
  };
}

function summarizeScopes(scopes: readonly SourceObservationIntegrationScope[]) {
  return scopes.reduce(
    (summary, scope) => ({
      scopes: summary.scopes + 1,
      total: summary.total + scope.total_observations,
      observed: summary.observed + scope.observed_observations,
      changed: summary.changed + scope.changed_observations,
      promoted: summary.promoted + scope.promoted_observations,
    }),
    {
      scopes: 0,
      total: 0,
      observed: 0,
      changed: 0,
      promoted: 0,
    },
  );
}

function reviewableObservationCount(scope: SourceObservationIntegrationScope): number {
  return scope.observed_observations + scope.changed_observations;
}

function toSelectItems(options: readonly SourceObservationIntegrationOption[]): SelectItem[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description ?? undefined,
  }));
}

function withSelectedFallback(options: readonly SelectItem[], selectedValue: string): SelectItem[] {
  if (!selectedValue || options.some((option) => option.value === selectedValue)) {
    return [...options];
  }

  return [
    {
      label: selectedValue,
      value: selectedValue,
    },
    ...options,
  ];
}

function profileActionIdentity(profile: Pick<CatalogProviderProfileVersionReview, "providerKey" | "profileVersion">) {
  return `${profile.providerKey}:${profile.profileVersion}`;
}

function nextProfileVersion(currentVersion = ""): string {
  const match = currentVersion.match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return new Date().toISOString().slice(0, 10).replaceAll("-", ".");
  }

  return `${match[1]}.${match[2]}.${match[3]}.${match[4] ? Number(match[4]) + 1 : 1}`;
}

function profileEditableJson(profile: CatalogProviderProfileVersionReview | null) {
  if (!profile) {
    return {
      profile: null,
      sourceContract: null,
      fixtures: null,
      compatibilityMode: null,
      retirementPlan: null,
      executableMappingContract: null,
    };
  }

  return {
    profile: profile.profile,
    sourceContract: profile.sourceContract,
    fixtures: profile.fixtures,
    compatibilityMode: profile.compatibilityMode,
    retirementPlan: profile.retirementPlan,
    executableMappingContract: profile.executableMappingContract,
  };
}

function activeProfileFor(
  profile: CatalogProviderProfileVersionReview,
  profiles: readonly CatalogProviderProfileVersionReview[],
): CatalogProviderProfileVersionReview | null {
  return profiles.find((candidate) => candidate.providerKey === profile.providerKey && candidate.active) ?? null;
}

function profileComparisonItems(
  candidate: CatalogProviderProfileVersionReview,
  active: CatalogProviderProfileVersionReview | null,
) {
  return [
    { key: "Provider", value: candidate.displayName },
    { key: "Active version", value: active?.profileVersion ?? "None" },
    { key: "Candidate version", value: candidate.profileVersion },
    { key: "Active lifecycle", value: active?.lifecycle ?? "None" },
    { key: "Candidate lifecycle", value: candidate.lifecycle },
    { key: "Active output", value: active?.mappingOutputKind ?? "None" },
    { key: "Candidate output", value: candidate.mappingOutputKind },
  ];
}

function profileBasicsForm(profile: CatalogProviderProfileVersionReview): ProfileBasicsForm {
  const retirementPlan = profile.retirementPlan;
  const retirementPlanObject = isRecord(retirementPlan) ? retirementPlan : null;
  const trackingIssue =
    typeof retirementPlanObject?.trackingIssue === "number" ? String(retirementPlanObject.trackingIssue) : "";
  const diagnosticText =
    typeof retirementPlanObject?.diagnosticText === "string" ? retirementPlanObject.diagnosticText : "";
  const optionQueries =
    isRecord(profile.profile) && Array.isArray(profile.profile.optionQueries)
      ? profile.profile.optionQueries.map(profileOptionQueryForm)
      : [];

  return {
    displayName: profile.displayName,
    lifecycle: profile.lifecycle === "test" ? "test" : "draft",
    status: profile.status === "active" ? "active" : "planned",
    compatibilityMode:
      profile.compatibilityMode === "transitional-static-profile"
        ? "transitional-static-profile"
        : "executable-mapping-contract",
    capabilities: [...profile.capabilities],
    supportedScopes: [...profile.supportedScopes],
    languageOptionsText: profile.languageOptions.join("\n"),
    sourceContract: {
      owner: profile.sourceContract.owner,
      repository: profile.sourceContract.repository ?? "",
      commit: profile.sourceContract.commit ?? "",
      documentPath: profile.sourceContract.documentPath,
      fixtureSetVersion: profile.sourceContract.fixtureSetVersion,
    },
    retirementPlan: {
      enabled: Boolean(retirementPlanObject),
      trackingIssueText: trackingIssue,
      diagnosticText,
    },
    optionQueries,
    connector: profileConnectorForm(isRecord(profile.profile) ? profile.profile.connector : null),
    fixtures: {
      fixtureRoot: profile.fixtures.fixtureRoot,
      coveredFlows: [...profile.fixtures.coveredFlows],
    },
    normalizedObservation: profileNormalizedObservationForm(profile),
  };
}

function profileBasicsSaveDisabled(
  profile: CatalogProviderProfileVersionReview | null,
  form: ProfileBasicsForm | null,
): boolean {
  if (!profile || !form || !profileLifecycleEditable(profile)) {
    return true;
  }

  if (
    !form.displayName.trim() ||
    form.capabilities.length === 0 ||
    !form.sourceContract.owner.trim() ||
    !form.sourceContract.documentPath.trim() ||
    !form.sourceContract.fixtureSetVersion.trim()
  ) {
    return true;
  }

  return (
    (form.retirementPlan.enabled &&
      (!positiveIntegerText(form.retirementPlan.trackingIssueText) || !form.retirementPlan.diagnosticText.trim())) ||
    validateOptionQueryForms(form.optionQueries).length > 0 ||
    validateConnectorForm(form.connector).length > 0 ||
    validateNormalizedObservationForm(form.normalizedObservation).length > 0 ||
    !form.fixtures.fixtureRoot.trim()
  );
}

function profileLifecycleEditable(profile: CatalogProviderProfileVersionReview): boolean {
  return !profile.active && (profile.lifecycle === "draft" || profile.lifecycle === "test");
}

function parseListInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNumberListInput(value: string): number[] {
  return parseListInput(value)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry));
}

function nullableTrimmedValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function profileNormalizedObservationForm(
  profile: CatalogProviderProfileVersionReview,
): ProfileNormalizedObservationForm {
  const profileRecord = isRecord(profile.profile) ? profile.profile : {};
  const profileMapping = isRecord(profileRecord.normalizedObservationMapping)
    ? { ...profileRecord.normalizedObservationMapping }
    : {};
  const contractRoot = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : {};
  const normalizedObservation = isRecord(contractRoot.normalizedObservation) ? contractRoot.normalizedObservation : {};
  const fields = isRecord(normalizedObservation.fields) ? normalizedObservation.fields : {};
  const outputKind = normalizedOutputKindValue(
    normalizedObservation.outputKind,
    profileMapping.kind,
    profile.mappingOutputKind,
  );

  return {
    outputKind,
    profileMapping,
    languageCode: mappingExpressionFromUnknown(
      normalizedObservation.languageCode,
      defaultPathExpression("languageCode", "catalog-truth", ["normalized-observation", "hash-material"]),
    ),
    fields: Object.entries(fields).map(([fieldKey, expression], index) => ({
      id: `field-${fieldKey || index}`,
      fieldKey,
      expression: mappingExpressionFromUnknown(
        expression,
        defaultPathExpression(fieldKey, "catalog-truth", ["normalized-observation"]),
      ),
    })),
    hashMaterial: expressionListForm(normalizedObservation.hashMaterial, "hash", ["hash-material"]),
    mergeIdentity: expressionListForm(normalizedObservation.mergeIdentity, "merge", ["merge-identity"]),
  };
}

function normalizedOutputKindValue(...values: readonly unknown[]): "pokemon-card" | "provider-product" {
  return values.some((value) => value === "pokemon-card") ? "pokemon-card" : "provider-product";
}

function expressionListForm(
  value: unknown,
  prefix: string,
  uses: MappingExpressionValue["uses"],
): readonly ProfileExpressionListItemForm[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((expression, index) => ({
    id: `${prefix}-${index}`,
    expression: mappingExpressionFromUnknown(expression, defaultPathExpression("", "catalog-truth", uses)),
  }));
}

function mappingExpressionFromUnknown(value: unknown, fallback: MappingExpressionValue): MappingExpressionValue {
  if (!isRecord(value) || !isRecord(value.selector)) {
    return fallback;
  }
  return value as unknown as MappingExpressionValue;
}

function defaultPathExpression(
  path: string,
  owner: MappingExpressionValue["owner"],
  uses: MappingExpressionValue["uses"],
): MappingExpressionValue {
  return {
    ...defaultExpression(),
    selector: { kind: "path", path, required: true, nullPolicy: "diagnostic" },
    owner,
    uses,
  };
}

function emptyExpressionFieldForm(): ProfileExpressionFieldForm {
  return {
    id: newFormRowId("field"),
    fieldKey: "",
    expression: defaultPathExpression("", "catalog-truth", ["normalized-observation"]),
  };
}

function emptyExpressionListItemForm(): ProfileExpressionListItemForm {
  return {
    id: newFormRowId("expression"),
    expression: defaultPathExpression("", "catalog-truth", ["hash-material"]),
  };
}

function normalizedObservationMappingFormToCommand(
  form: ProfileNormalizedObservationForm,
): CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationMapping"] {
  return {
    ...form.profileMapping,
    kind: form.outputKind,
  } as CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationMapping"];
}

function normalizedObservationContractFormToCommand(
  form: ProfileNormalizedObservationForm,
): CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationContract"] {
  return {
    outputKind: form.outputKind,
    languageCode: form.languageCode,
    fields: Object.fromEntries(
      form.fields.map((field) => [field.fieldKey.trim(), field.expression]).filter(([fieldKey]) => fieldKey),
    ),
    hashMaterial: form.hashMaterial.map((item) => item.expression),
    mergeIdentity: form.mergeIdentity.map((item) => item.expression),
  } as CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationContract"];
}

function validateNormalizedObservationForm(form: ProfileNormalizedObservationForm): string[] {
  const diagnostics: string[] = [];
  const seenFields = new Set<string>();

  diagnostics.push(...prefixedExpressionDiagnostics("Language expression", form.languageCode));

  for (const field of form.fields) {
    const fieldKey = field.fieldKey.trim();
    const label = fieldKey || "Normalized field";
    if (!fieldKey) {
      diagnostics.push("Normalized field key is required.");
    }
    if (seenFields.has(fieldKey)) {
      diagnostics.push(`${label}: normalized field keys must be unique.`);
    }
    seenFields.add(fieldKey);
    diagnostics.push(...prefixedExpressionDiagnostics(label, field.expression));
    diagnostics.push(...unsafeEvidenceDiagnostics(label, field.expression, "normalized field"));
  }

  if (form.hashMaterial.length === 0) {
    diagnostics.push("Hash material needs at least one expression.");
  }
  form.hashMaterial.forEach((item, index) => {
    const label = `Hash material ${index + 1}`;
    diagnostics.push(...prefixedExpressionDiagnostics(label, item.expression));
    diagnostics.push(...unsafeEvidenceDiagnostics(label, item.expression, "hash material"));
  });

  if (form.mergeIdentity.length === 0) {
    diagnostics.push("Merge identity needs at least one expression.");
  }
  form.mergeIdentity.forEach((item, index) => {
    const label = `Merge identity ${index + 1}`;
    diagnostics.push(...prefixedExpressionDiagnostics(label, item.expression));
    diagnostics.push(...unsafeEvidenceDiagnostics(label, item.expression, "merge identity"));
  });

  return diagnostics;
}

function prefixedExpressionDiagnostics(label: string, expression: MappingExpressionValue): string[] {
  return validateMappingExpression(expression).map((diagnostic) => `${label}: ${diagnostic}`);
}

function unsafeEvidenceDiagnostics(
  label: string,
  expression: MappingExpressionValue,
  surface: "normalized field" | "hash material" | "merge identity",
): string[] {
  const diagnostics: string[] = [];
  for (const candidate of expressionTree(expression)) {
    const selectorPath = selectorEvidencePath(candidate.selector).toLowerCase();
    const unsafePath = [
      "price",
      "pricing",
      "inventory",
      "seller",
      "listing",
      "order",
      "message",
      "auth",
      "cookie",
    ].some((token) => selectorPath.includes(token));
    const unsafeOwner =
      candidate.owner === "pricing-signal" ||
      candidate.owner === "inventory-signal" ||
      candidate.owner === "operations";
    const unsafeRedaction = candidate.redaction !== "none";
    const drivesCatalogTruth = candidate.uses.includes("normalized-observation") || candidate.owner === "catalog-truth";
    const drivesHash = candidate.uses.includes("hash-material") || surface === "hash material";

    if ((unsafeOwner || unsafeRedaction || unsafePath) && (drivesCatalogTruth || drivesHash)) {
      diagnostics.push(
        `${label}: ${surface} cannot use secret, pricing, inventory, operations, seller, listing, order, or message evidence.`,
      );
      break;
    }
  }
  return diagnostics;
}

function expressionTree(expression: MappingExpressionValue): readonly MappingExpressionValue[] {
  const nested: MappingExpressionValue[] = [expression];
  const selector = expression.selector;
  if (selector.kind === "template") {
    nested.push(...Object.values(selector.values).flatMap((value) => expressionTree(value)));
  }
  if (selector.kind === "array") {
    nested.push(...selector.items.flatMap((value) => expressionTree(value)));
  }
  if (selector.kind === "object") {
    nested.push(...Object.values(selector.fields).flatMap((value) => expressionTree(value)));
  }
  if (selector.kind === "array-map") {
    nested.push(...expressionTree(selector.item));
  }
  return nested;
}

function selectorEvidencePath(selector: MappingExpressionValue["selector"]): string {
  if (selector.kind === "path" || selector.kind === "array-map") {
    return selector.path;
  }
  if (selector.kind === "template") {
    return selector.template;
  }
  if (selector.kind === "named-runtime-selector") {
    return `${selector.functionKey} ${selector.reason}`;
  }
  return "";
}

function profileConnectorForm(value: unknown): ProfileConnectorForm {
  const connector = isRecord(value) ? value : {};
  const tcgdexEndpoints = isRecord(connector.endpoints) ? connector.endpoints : {};
  const tcgplayerRepository = isRecord(connector.sourceRepository) ? connector.sourceRepository : {};
  const tcgplayerAuthentication = isRecord(connector.authentication) ? connector.authentication : {};
  const tcgplayerDomains = isRecord(connector.domains) ? connector.domains : {};

  return {
    kind: stringValue(connector.kind) || "scrydex-scryfall-json",
    tcgdexBaseUrl: stringValue(connector.baseUrl) || "https://api.tcgdex.net/v2",
    tcgdexHighQualityAssetVariant: stringValue(connector.highQualityAssetVariant) || "high.webp",
    tcgdexSeriesListEndpoint: stringValue(tcgdexEndpoints.seriesList) || "/{language}/series",
    tcgdexSeriesDetailEndpoint: stringValue(tcgdexEndpoints.seriesDetail) || "/{language}/series/{seriesId}",
    tcgdexExpansionListEndpoint: stringValue(tcgdexEndpoints.expansionList) || "/{language}/sets",
    tcgdexExpansionDetailEndpoint: stringValue(tcgdexEndpoints.expansionDetail) || "/{language}/sets/{expansionId}",
    tcgdexProductDetailEndpoint: stringValue(tcgdexEndpoints.productDetail) || "/{language}/cards/{cardId}",
    tcgplayerRepositoryOwner: stringValue(tcgplayerRepository.owner) || "todd-skelton",
    tcgplayerRepositoryName: stringValue(tcgplayerRepository.name) || "tcgplayer-automation-app",
    tcgplayerRepositoryCommit: stringValue(tcgplayerRepository.commit),
    tcgplayerSourceContractDocument:
      stringValue(connector.sourceContractDocument) ||
      "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    tcgplayerCookieName: stringValue(tcgplayerAuthentication.cookieName) || "TCGAuthTicket_Production",
    tcgplayerSearchDomain: stringValue(tcgplayerDomains.search) || "mp-search-api.tcgplayer.com",
    tcgplayerMarketplaceApiDomain: stringValue(tcgplayerDomains.marketplaceApi) || "mpapi.tcgplayer.com",
    tcgplayerInfiniteApiDomain: stringValue(tcgplayerDomains.infiniteApi) || "infinite-api.tcgplayer.com",
    tcgplayerMarketplaceGatewayDomain: stringValue(tcgplayerDomains.marketplaceGateway) || "mpgateway.tcgplayer.com",
    tcgplayerRetryStatusCodesText: Array.isArray(connector.retryStatusCodes)
      ? connector.retryStatusCodes.map(String).join(", ")
      : "403, 429, 502, 503, 504",
    scrydexSourceContractDocument:
      stringValue(connector.sourceContractDocument) || "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    scrydexAcceptedEvidenceText: arrayText(connector.acceptedEvidence),
    scrydexExcludedEvidenceText: arrayText(connector.excludedEvidence),
  };
}

function connectorFormToCommand(
  connector: ProfileConnectorForm,
): CatalogProviderProfileConnectorUpdateCommand["connector"] {
  if (connector.kind === "tcgdex-json") {
    return {
      kind: "tcgdex-json",
      baseUrl: connector.tcgdexBaseUrl.trim(),
      highQualityAssetVariant: connector.tcgdexHighQualityAssetVariant.trim(),
      endpoints: {
        seriesList: connector.tcgdexSeriesListEndpoint.trim(),
        seriesDetail: connector.tcgdexSeriesDetailEndpoint.trim(),
        expansionList: connector.tcgdexExpansionListEndpoint.trim(),
        expansionDetail: connector.tcgdexExpansionDetailEndpoint.trim(),
        productDetail: connector.tcgdexProductDetailEndpoint.trim(),
      },
    };
  }

  if (connector.kind === "tcgplayer-automation-client") {
    return {
      kind: "tcgplayer-automation-client",
      sourceRepository: {
        owner: connector.tcgplayerRepositoryOwner.trim(),
        name: connector.tcgplayerRepositoryName.trim(),
        commit: connector.tcgplayerRepositoryCommit.trim(),
      },
      sourceContractDocument: connector.tcgplayerSourceContractDocument.trim(),
      authentication: {
        scheme: "tcgplayer-production-cookie",
        cookieName: connector.tcgplayerCookieName.trim(),
        userAgentRequired: true,
      },
      domains: {
        search: connector.tcgplayerSearchDomain.trim(),
        marketplaceApi: connector.tcgplayerMarketplaceApiDomain.trim(),
        infiniteApi: connector.tcgplayerInfiniteApiDomain.trim(),
        marketplaceGateway: connector.tcgplayerMarketplaceGatewayDomain.trim(),
      },
      retryStatusCodes: parseNumberListInput(connector.tcgplayerRetryStatusCodesText),
      throttling: {
        strategy: "domain-adaptive",
        controls: ["request-delay", "cooldown", "max-concurrency", "learned-min-delay"],
      },
      catalogFlow: {
        productLineScope: "product-lines",
        setScope: "catalog-set-names-by-product-line",
        productScope: "product-search-by-set",
        detailScope: "product-detail-with-skus",
        detectsProductSetReclassification: true,
      },
      externalReferencePolicy: {
        catalogItemReferencePrefix: "product:",
        productReferencePrefix: "sku:",
        productConditionIdSource: "sku-product-condition-id",
      },
      catalogBoundary: {
        acceptedEvidence: ["product-id", "sku-id", "product-condition-id", "set-name", "product-line"],
        excludedEvidence: ["listing-price", "sales-history", "order", "message", "seller-inventory"],
      },
    };
  }

  return {
    kind: "scrydex-scryfall-json",
    sourceContractDocument: connector.scrydexSourceContractDocument.trim(),
    fixtureBackedOnly: true,
    acceptedEvidence: parseListInput(connector.scrydexAcceptedEvidenceText),
    excludedEvidence: parseListInput(connector.scrydexExcludedEvidenceText),
  };
}

function validateConnectorForm(connector: ProfileConnectorForm): string[] {
  if (connector.kind === "tcgdex-json") {
    return requiredConnectorFields("TCGdex connector", [
      connector.tcgdexBaseUrl,
      connector.tcgdexHighQualityAssetVariant,
      connector.tcgdexSeriesListEndpoint,
      connector.tcgdexSeriesDetailEndpoint,
      connector.tcgdexExpansionListEndpoint,
      connector.tcgdexExpansionDetailEndpoint,
      connector.tcgdexProductDetailEndpoint,
    ]);
  }
  if (connector.kind === "tcgplayer-automation-client") {
    return requiredConnectorFields("TCGplayer connector", [
      connector.tcgplayerRepositoryOwner,
      connector.tcgplayerRepositoryName,
      connector.tcgplayerRepositoryCommit,
      connector.tcgplayerSourceContractDocument,
      connector.tcgplayerCookieName,
      connector.tcgplayerSearchDomain,
      connector.tcgplayerMarketplaceApiDomain,
      connector.tcgplayerInfiniteApiDomain,
      connector.tcgplayerMarketplaceGatewayDomain,
    ]);
  }
  return requiredConnectorFields("Scrydex connector", [connector.scrydexSourceContractDocument]);
}

function requiredConnectorFields(label: string, values: readonly string[]): string[] {
  return values.some((value) => !value.trim()) ? [`${label}: required connector fields are missing.`] : [];
}

function profileOptionQueryForm(value: unknown, index: number): ProfileOptionQueryForm {
  const query = isRecord(value) ? value : {};
  const output = isRecord(query.output) ? query.output : {};
  const parentValue = isRecord(query.parentValue) ? query.parentValue : null;
  const description = isRecord(output.description) ? output.description : null;

  return {
    id: `${stringValue(query.queryKind) || "query"}-${index}`,
    queryKind: stringValue(query.queryKind),
    aliasesText: arrayText(query.aliases),
    displayName: stringValue(query.displayName),
    scope: stringValue(query.scope) || "product/card",
    parentScope: stringValue(query.parentScope) || "__none__",
    parentRequired: parentValue?.required === true,
    parentValueKind: stringValue(parentValue?.valueKind),
    parentDiagnosticText: stringValue(parentValue?.diagnosticText),
    operation: stringValue(query.operation) || OPTION_QUERY_OPERATION_OPTIONS[0].value,
    valuePath: stringValue(output.valuePath),
    labelPath: stringValue(output.labelPath),
    descriptionKind: stringValue(description?.kind) || "__none__",
    descriptionPath: stringValue(description?.path),
    parentValuePath: stringValue(output.parentValuePath),
    imageUrlPath: stringValue(output.imageUrlPath),
    imageUrlCoalescePathsText: arrayText(output.imageUrlCoalescePaths),
    metadataPathsText: metadataPathsText(output.metadataPaths),
  };
}

function emptyOptionQueryForm(): ProfileOptionQueryForm {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queryKind: "",
    aliasesText: "",
    displayName: "",
    scope: "product/card",
    parentScope: "__none__",
    parentRequired: false,
    parentValueKind: "",
    parentDiagnosticText: "",
    operation: OPTION_QUERY_OPERATION_OPTIONS[0].value,
    valuePath: "",
    labelPath: "",
    descriptionKind: "__none__",
    descriptionPath: "",
    parentValuePath: "",
    imageUrlPath: "",
    imageUrlCoalescePathsText: "",
    metadataPathsText: "",
  };
}

function optionQueryFormToCommand(
  query: ProfileOptionQueryForm,
): CatalogProviderProfileProviderOptionsUpdateCommand["optionQueries"][number] {
  const output: CatalogProviderProfileProviderOptionsUpdateCommand["optionQueries"][number]["output"] = {
    valuePath: query.valuePath.trim(),
    labelPath: query.labelPath.trim(),
    metadataPaths: metadataPathsObject(query.metadataPathsText),
  };
  const parentValuePath = nullableTrimmedValue(query.parentValuePath);
  const imageUrlPath = nullableTrimmedValue(query.imageUrlPath);
  const imageUrlCoalescePaths = parseListInput(query.imageUrlCoalescePathsText);
  if (parentValuePath) {
    output.parentValuePath = parentValuePath;
  }
  if (imageUrlPath) {
    output.imageUrlPath = imageUrlPath;
  }
  if (imageUrlCoalescePaths.length > 0) {
    output.imageUrlCoalescePaths = imageUrlCoalescePaths;
  }
  if (query.descriptionKind === "path" && query.descriptionPath.trim()) {
    output.description = { kind: "path", path: query.descriptionPath.trim() };
  } else if (query.descriptionKind !== "__none__" && query.descriptionKind !== "path") {
    output.description = { kind: query.descriptionKind };
  }

  const command: CatalogProviderProfileProviderOptionsUpdateCommand["optionQueries"][number] = {
    queryKind: query.queryKind.trim(),
    displayName: query.displayName.trim(),
    scope: query.scope,
    parentScope: query.parentScope === "__none__" ? null : query.parentScope,
    operation: query.operation,
    output,
  };
  const aliases = parseListInput(query.aliasesText);
  if (aliases.length > 0) {
    command.aliases = aliases;
  }
  if (query.parentScope !== "__none__") {
    command.parentValue = {
      required: query.parentRequired,
      valueKind: query.parentValueKind.trim(),
      diagnosticText: query.parentDiagnosticText.trim(),
    };
  }

  return command;
}

function validateOptionQueryForms(queries: readonly ProfileOptionQueryForm[]): string[] {
  const diagnostics: string[] = [];
  const seenKeys = new Set<string>();

  queries.forEach((query, index) => {
    const label = query.displayName.trim() || query.queryKind.trim() || `Option query ${index + 1}`;
    if (!query.queryKind.trim()) {
      diagnostics.push(`${label}: query kind is required.`);
    }
    if (!query.displayName.trim()) {
      diagnostics.push(`${label}: display name is required.`);
    }
    if (!query.valuePath.trim() || !query.labelPath.trim()) {
      diagnostics.push(`${label}: value path and label path are required.`);
    }
    if (query.descriptionKind === "path" && !query.descriptionPath.trim()) {
      diagnostics.push(`${label}: description path is required when description uses a path.`);
    }
    if (query.parentScope !== "__none__" && (!query.parentValueKind.trim() || !query.parentDiagnosticText.trim())) {
      diagnostics.push(`${label}: parent value kind and diagnostic are required when a parent scope is selected.`);
    }

    for (const key of [query.queryKind, ...parseListInput(query.aliasesText)]) {
      const normalized = key.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (seenKeys.has(normalized)) {
        diagnostics.push(`${label}: query kind and aliases must be unique.`);
        break;
      }
      seenKeys.add(normalized);
    }
  });

  return diagnostics;
}

function metadataPathsText(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return Object.entries(value)
    .map(([key, path]) => `${key}=${String(path)}`)
    .join("\n");
}

function metadataPathsObject(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...pathParts] = entry.split("=");
        return [key.trim(), pathParts.join("=").trim()];
      })
      .filter(([key, path]) => key.length > 0 && path.length > 0),
  );
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join("\n") : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toggleStringSelection(selected: readonly string[], option: string): readonly string[] {
  return selected.includes(option) ? selected.filter((entry) => entry !== option) : [...selected, option];
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): readonly T[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

function insertItem<T>(items: readonly T[], index: number, item: T): readonly T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function newFormRowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function dryRunFixtureItems(model: CatalogProviderProfileAuthoringModel): SelectItem[] {
  return model.fixtureCases.map((fixtureCase) => ({
    value: fixtureCase.flow,
    label: `${fixtureCase.flow}${fixtureCase.samplePayloadAvailable ? "" : " (missing sample)"}`,
    disabled: !fixtureCase.samplePayloadAvailable,
  }));
}

function selectedDryRunFixture(model: CatalogProviderProfileAuthoringModel | null, flow: string) {
  return model?.fixtureCases.find((fixtureCase) => fixtureCase.flow === flow) ?? null;
}

function selectedDryRunPayload(model: CatalogProviderProfileAuthoringModel | null, flow: string) {
  const fixture = selectedDryRunFixture(model, flow);
  return fixture?.samplePayload ?? model?.dryRunInputTemplate.payload ?? null;
}

function summarizeDiffValue(
  value: CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]["candidate"],
): string {
  return summarizeJsonValue(value);
}

function summarizeJsonValue(
  value: CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]["candidate"],
): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map((entry) => summarizeJsonValue(entry)).join(", ");
  }
  if (typeof value === "object") {
    if ("externalKey" in value && typeof value.externalKey === "string") {
      return value.externalKey;
    }
    if ("optionKey" in value && typeof value.optionKey === "string") {
      return value.optionKey;
    }
    if ("dimensionKey" in value && typeof value.dimensionKey === "string") {
      return value.dimensionKey;
    }
    return Object.keys(value).length === 0 ? "None" : `${Object.keys(value).length} fields`;
  }
  return String(value);
}

function defaultDryRunPayload(providerKey = "scrydex"): string {
  if (providerKey === "scrydex") {
    return formatJson({
      object: "card",
      id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
      name: "Fury Sliver",
      lang: "en",
      released_at: "2006-10-06",
      scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
      set: "tsp",
      set_name: "Time Spiral",
      collector_number: "157",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
      },
      tcgplayer_id: 14240,
      prices: {
        usd: "0.42",
      },
    });
  }

  if (providerKey === TCGPLAYER_PROVIDER) {
    return formatJson({
      observationId: "tcgplayer_en_product_610001",
      externalKey: "product:610001",
      sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
      sourceUpdatedAt: "2025-01-17",
      sourcePayload: {
        productId: 610001,
        productName: "Eevee ex",
      },
      productId: 610001,
      productName: "Eevee ex",
      productLineName: "Pokemon",
      productLineId: 3,
      productTypeName: "Cards",
      setName: "Prismatic Evolutions",
      customAttributes: { number: "167/131" },
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      externalProductReferences: [],
      skuReferences: [],
      productForm: "single",
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: "Prismatic Evolutions",
        printedProductName: "Eevee ex",
        collectorNumber: "167/131",
        languageCode: "en",
        productForm: "single",
      },
      catalogHashMaterial: {
        productId: 610001,
        productName: "Eevee ex",
        setName: "Prismatic Evolutions",
        number: "167/131",
      },
      marketPrice: "redacted by dry-run",
    });
  }

  return formatJson({
    observationId: "tcgdex_en_fixture",
    externalKey: "fixture",
    sourceUrl: "https://example.invalid/provider-fixture",
    sourceUpdatedAt: "2026-06-03",
    sourcePayload: {},
    languageCode: "en",
  });
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sourceObservationScopeHref(scope: SourceObservationIntegrationScope) {
  const params = new URLSearchParams();
  params.set("source", scope.provider_key);
  params.set("language", scope.language_code);

  if (scope.expansion_id) {
    params.set("setId", scope.expansion_id);
  }

  return `/catalog/source-observations?${params.toString()}`;
}

function positiveIntegerText(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function queuedProgress(): CatalogBulkActionProgress {
  return {
    phase: "queued",
    completed: 0,
    total: 0,
    currentName: null,
    status: null,
  };
}

function bulkActionProgressPercent(progress: CatalogBulkActionProgress): number {
  if (progress.phase === "completed") {
    return 100;
  }

  if (progress.total <= 0) {
    return 0;
  }

  return (progress.completed / progress.total) * 100;
}

function formatBulkActionProgress(progress: CatalogBulkActionProgress): string {
  if (progress.phase === "queued") {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.queued");
  }

  if (progress.total <= 0) {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.preparing");
  }

  if (progress.phase === "completed") {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.completed", {
      completed: String(progress.completed),
      total: String(progress.total),
    });
  }

  return t("catalog.features.sourceObservations.ui.list.bulk.progress.processing", {
    completed: String(progress.completed),
    total: String(progress.total),
  });
}

function formatReapplyScope(scope: Required<SourceObservationPromotionScope>): string {
  const parts = [
    scope.search
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.search", {
          search: scope.search,
        })
      : "",
    scope.language
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.language", {
          language: formatLanguageCodeLabel(scope.language),
        })
      : "",
    scope.provider
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.provider", {
          provider: scope.provider,
        })
      : "",
    scope.setId
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.expansion", {
          setId: scope.setId,
        })
      : "",
  ].filter(Boolean);

  return parts.length > 0
    ? parts.join(", ")
    : t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.all");
}

function addIntegrationJobCompletionToast(
  action: "import" | "reapply",
  result: SourceObservationIntegrationJobResult,
  addToast: (message: string, tone: "success" | "warning" | "danger") => void,
) {
  if (action === "import") {
    addToast(
      t("catalog.features.sourceObservations.ui.integrations.import.completed", {
        imported: String(result.imported),
        observed: String(result.observed),
        failed: String(result.failed),
      }),
      result.failed > 0 ? "warning" : "success",
    );
    return;
  }

  addToast(
    t("catalog.features.sourceObservations.ui.integrations.reapply.completed", {
      reapplied: String(result.reapplied),
      skipped: String(result.skipped),
      failed: String(result.failed),
    }),
    result.failed > 0 ? "warning" : "success",
  );
}

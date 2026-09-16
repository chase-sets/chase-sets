import childProcess from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

export const TESTED_DESIGN_SYSTEM_ROOT_EXPORTS = Object.freeze([
  "Accordion",
  "AccordionOptionTrigger",
  "AccountCredibilityHeader",
  "AccountMenu",
  "AccountProfileHeader",
  "AccountReputationSummary",
  "AccountTrustCard",
  "ActionBar",
  "ActionRow",
  "ActionStack",
  "ActivityList",
  "ActivitySheet",
  "ActorIdentityCue",
  "AddressBlock",
  "AdminResourceDetailPage",
  "AdminResourceListPage",
  "AdminShell",
  "AlertDialog",
  "AppliedFilterChips",
  "AspectRatio",
  "AssistantSheet",
  "AutoGrid",
  "Autocomplete",
  "Avatar",
  "Badge",
  "BadgeCluster",
  "Banner",
  "Bleed",
  "BottomNav",
  "BottomSheet",
  "Box",
  "BrandFoilText",
  "BrandLink",
  "Breadcrumbs",
  "BulkActionBar",
  "BulkActionPanel",
  "BulkActionSurface",
  "Button",
  "ButtonGroup",
  "Calendar",
  "Caption",
  "Card",
  "CategoryTile",
  "Center",
  "ChaseRoot",
  "ChaseSetsLogo",
  "Checkbox",
  "CheckboxGroup",
  "ChecklistCard",
  "CheckoutConfirmationPanel",
  "CheckoutExpressActions",
  "CheckoutFlowShell",
  "CheckoutFormSection",
  "CheckoutLayout",
  "CheckoutMobileSummaryDisclosure",
  "CheckoutNoticeStack",
  "CheckoutReadinessPrompt",
  "CheckoutSavedInfoGroup",
  "CheckoutSavedInfoRow",
  "CheckoutStateNotice",
  "CheckoutStickyActionBar",
  "CheckoutSummaryLineItem",
  "CheckoutSummaryPanel",
  "CheckoutTotals",
  "CheckoutTrustPanel",
  "Cluster",
  "ColorModeToggle",
  "Combobox",
  "CommentsSheet",
  "CommerceActionBar",
  "CommerceBottomSheet",
  "CommerceSheet",
  "ComparisonList",
  "ComparisonListCell",
  "ComparisonListHeader",
  "ComparisonListPrice",
  "ComparisonListRow",
  "ComparisonListRowGrid",
  "ComparisonModule",
  "ConditionBadge",
  "ConnectionStatusIndicator",
  "Container",
  "CopyButton",
  "CurrencyInput",
  "DataTable",
  "DateInput",
  "DatePicker",
  "DenseAdminWorkbench",
  "DenseAdminWorkbenchHeader",
  "DenseAdminWorkbenchLayout",
  "DenseAdminWorkbenchProof",
  "DesktopActionBar",
  "DestructiveAction",
  "DetailConfidenceModule",
  "DetailPanel",
  "Dialog",
  "DiscountValue",
  "Divider",
  "EmbeddedProviderSurface",
  "EmptyState",
  "EmptyStateIllustration",
  "EvidenceCodeBlock",
  "EvidenceList",
  "EvidencePanel",
  "EvidenceStringList",
  "Eyebrow",
  "FeatureCard",
  "Field",
  "Fieldset",
  "FileDropzone",
  "FilterArea",
  "FilterBar",
  "FilterBottomSheet",
  "FlexItem",
  "Form",
  "FormPanel",
  "FormRow",
  "FormSection",
  "FullPage",
  "Grid",
  "Heading",
  "HelpSheet",
  "HelperText",
  "HiddenInput",
  "HoneypotInput",
  "Icon",
  "IconButton",
  "IconRow",
  "Image",
  "ImageGallery",
  "Inline",
  "InlineMessage",
  "InlineTextGroup",
  "Inset",
  "InspectorLayout",
  "KeyValueList",
  "Label",
  "LinkButton",
  "LinkText",
  "List",
  "ListingCard",
  "ListingPurchasePanel",
  "LiveRegion",
  "LoadingSpinner",
  "MarketStatusBadge",
  "MarketingImageHero",
  "MarketplaceActionSheet",
  "MarketplaceCartLineItem",
  "MarketplaceDashboardPanel",
  "MarketplaceEmptyState",
  "MarketplaceFacetChoiceGroup",
  "MarketplaceFacetGroup",
  "MarketplaceFacetRail",
  "MarketplaceFacetStrip",
  "MarketplaceFilterBottomSheet",
  "MarketplaceMarketSummary",
  "MarketplaceMobileFilterBar",
  "MarketplaceNotice",
  "MarketplaceProductCard",
  "MarketplaceProductCommerceRail",
  "MarketplaceProductDetailLayout",
  "MarketplaceProductMobileActionDock",
  "MarketplaceShell",
  "MarketplaceStatusTimeline",
  "MarketplaceTemplateGallery",
  "MediaFrame",
  "Menu",
  "MessageThreadPreview",
  "MetricStrip",
  "MobileStickyBar",
  "MobileStickyInset",
  "ModalDialog",
  "MountPoint",
  "NativeSelect",
  "NavRail",
  "NavigationDrawer",
  "NavigationHeader",
  "NavigationMenu",
  "NoResultsRecovery",
  "NotificationCenterSheet",
  "NumberField",
  "OfferCard",
  "OperationalLockBanner",
  "OperationalStatusBanner",
  "OrderIntentSummary",
  "OrderProtectionBadge",
  "OrderProtectionModule",
  "PackingSlipPrintDocument",
  "Page",
  "PageHeader",
  "PageSection",
  "PageStepper",
  "Pagination",
  "PanelSectionAccordion",
  "PasswordInput",
  "PaymentRecoveryPanel",
  "PlatformCredibilityCue",
  "Popover",
  "PriceBreakdown",
  "ProductCard",
  "ProductMediaImage",
  "ProductMediaModule",
  "ProductOptions",
  "ProductSelectionFields",
  "Progress",
  "ProgressBar",
  "ProgressTrack",
  "ProgressiveDisclosure",
  "ProgressiveDisclosureGroup",
  "PromoBar",
  "PromoStrip",
  "QuantityChecklistControl",
  "QuantityStepper",
  "Quote",
  "RadioGroup",
  "Rating",
  "RatingDistribution",
  "RatingSummary",
  "RecordPage",
  "ReferenceInfoDialog",
  "ReferenceInfoTrigger",
  "ResponsiveActionMenu",
  "ResponsiveEditSheet",
  "ResponsiveSupportSheet",
  "Reveal",
  "ReviewCard",
  "ReviewContext",
  "SavedSearchPrompt",
  "ScrollArea",
  "SearchControlBar",
  "SearchFilterPanel",
  "SearchInput",
  "SearchResultsLayout",
  "SearchResultsTransition",
  "SectionNavigation",
  "SecurePaymentCue",
  "SecurePaymentIndicator",
  "SegmentedControl",
  "Select",
  "SelectionToolbar",
  "SellerBadge",
  "Show",
  "SideNav",
  "SideSheet",
  "Sidebar",
  "Skeleton",
  "SkipLink",
  "Slider",
  "Slot",
  "Spacer",
  "Sparkline",
  "SpecificationList",
  "SplitPane",
  "Stack",
  "Stagger",
  "Stat",
  "StatGrid",
  "StatusPill",
  "StatusReasonList",
  "StickyBar",
  "StickyCtaBar",
  "StickyTaskFooter",
  "Subheading",
  "Surface",
  "Switch",
  "Table",
  "Tabs",
  "Tag",
  "TagInput",
  "TaskLineItem",
  "TaskProgress",
  "TaskReference",
  "TaskScanInput",
  "TaskSummary",
  "Text",
  "TextInput",
  "Textarea",
  "ThemePreferenceControl",
  "ThemeScope",
  "Thumbnail",
  "TimeSeriesChart",
  "Timeline",
  "ToastProvider",
  "ToastRegion",
  "Toggle",
  "ToggleGroup",
  "TokenSwatch",
  "ToneIcon",
  "Toolbar",
  "ToolbarButton",
  "ToolbarInput",
  "ToolbarSeparator",
  "Tooltip",
  "TopNav",
  "TrustBadge",
  "ValidationMessageList",
  "ValidationSummary",
  "VerifiedAccountBadge",
  "ViewTransition",
  "VisuallyHidden",
  "Wizard",
  "WorkbenchActionRow",
  "WorkbenchDataCell",
  "WorkbenchDetailPanel",
  "WorkbenchForm",
  "WorkbenchFormGrid",
  "WorkbenchGrid",
  "WorkbenchGridSpan",
  "WorkbenchLinkList",
  "WorkbenchSplitHeader",
  "WorkbenchStack",
  "WorkbenchText",
  "WorkbenchValueList",
  "WorkflowActionBar",
  "WorkflowModule",
  "WorkflowReadinessChecklist",
  "WorkstationLayout",
  "chaseDarkTheme",
  "chaseSetsLogoSvg",
  "chaseTheme",
  "clearFieldError",
  "createStripeConnectAppearance",
  "createStripeElementsAppearance",
  "cx",
  "defaultToastManager",
  "firstFieldError",
  "formatMarketplaceNumber",
  "formatProductImageAltText",
  "formatProductOptionsAriaLabel",
  "formatProductOptionsText",
  "hasFormErrors",
  "layoutWidthClasses",
  "normalizeFormErrors",
  "observeStripeAppearance",
  "packingSlipPrintStyles",
  "productOptionsFromSummary",
  "renderOptionalNode",
  "resolveAlignClass",
  "resolveChaseMotion",
  "resolveColumnsClass",
  "resolveDirectionClass",
  "resolveJustifyClass",
  "resolveResponsiveClass",
  "resolveSpaceClass",
  "resolveSystemProps",
  "resolveTextAlignClass",
  "resolveTheme",
  "resolveThemeOverrideStyle",
  "resolveThemeStyle",
  "resolveTruncateClass",
  "selectCheckoutNotice",
  "showToast",
  "sidebarWidthClasses",
  "stripeAppearanceSnapshot",
  "surfaceSemanticToneClasses",
  "toastManager",
  "useChaseMotion",
  "useDensity",
  "useFormContext",
  "useFormState",
  "useMediaQuery",
  "usePortalRoots",
  "useReducedMotion",
  "useToast",
]);

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function compareDesignSystemExportCoverage({ runtimeExports, testedExports }) {
  const actual = uniqueSorted(runtimeExports);
  const tested = uniqueSorted(testedExports);
  const testedSet = new Set(tested);
  const actualSet = new Set(actual);
  const untestedExports = actual.filter((name) => !testedSet.has(name));
  const staleTestedExports = tested.filter((name) => !actualSet.has(name));

  return {
    actualExports: actual,
    testedExports: tested,
    untestedExports,
    staleTestedExports,
    passed: untestedExports.length === 0 && staleTestedExports.length === 0,
  };
}

function formatList(names) {
  return names.map((name) => `  - ${name}`).join("\n");
}

export function formatDesignSystemExportCoverageFailure(result) {
  const sections = ["Design-system root export coverage is out of date."];

  if (result.untestedExports.length > 0) {
    sections.push(
      [
        "",
        "Runtime exports missing from TESTED_DESIGN_SYSTEM_ROOT_EXPORTS:",
        formatList(result.untestedExports),
        "",
        "Add focused behavior or smoke coverage for each export before adding it to the allowlist.",
      ].join("\n"),
    );
  }

  if (result.staleTestedExports.length > 0) {
    sections.push(
      ["", "Allowlist entries that are no longer exported:", formatList(result.staleTestedExports)].join("\n"),
    );
  }

  return sections.join("\n");
}

export const RUNTIME_IMPORT_DEADLINE_MS = 60000;
const CHILD_CLEANUP_GRACE_MS = 5000;
const IMPORT_CHILD_FLAG = "--design-system-export-import-child";

function startRuntimeImportChild(rootDir, entrypointUrl) {
  const child = childProcess.spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), IMPORT_CHILD_FLAG, entrypointUrl],
    {
      cwd: rootDir,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  let closed = false;
  let message;
  let failure;
  let exit;
  let markClosed;
  let onClose;
  const closure = new Promise((resolve) => {
    markClosed = resolve;
  });
  const onMessage = (value) => {
    const hasKeys =
      Array.isArray(value?.keys) && value.keys.every((key) => typeof key === "string") && value.error === undefined;
    const hasError =
      value?.error &&
      typeof value.error.name === "string" &&
      typeof value.error.message === "string" &&
      typeof value.error.stack === "string" &&
      value.keys === undefined;
    if (message || value?.type !== "design-system-runtime-exports" || (!hasKeys && !hasError)) {
      failure = new Error("Malformed or duplicate runtime import child result");
      return;
    }
    message = value;
  };
  const onError = (error) => {
    failure = error;
  };
  const onExit = (code, signal) => {
    exit = { code, signal };
  };
  const result = new Promise((resolve, reject) => {
    child.on("message", onMessage);
    child.on("error", onError);
    child.once("exit", onExit);
    onClose = (code, signal) => {
      closed = true;
      markClosed();
      if (failure) return reject(failure);
      if (message?.error) {
        const error = new Error(message.error.message, { cause: message.error });
        error.name = message.error.name;
        error.childExitCode = code;
        error.childSignal = signal;
        return reject(error);
      }
      if (!exit || exit.code !== 0 || exit.signal || code !== 0 || signal) {
        return reject(new Error(`Runtime import child exited with code ${code}, signal ${signal}`));
      }
      if (!message) return reject(new Error("Runtime import child closed without a result"));
      resolve(message.keys);
    };
    child.once("close", onClose);
  });
  return {
    result,
    async dispose() {
      let cleanupTimer;
      try {
        if (!closed) {
          let terminationError;
          try {
            child.kill();
          } catch (error) {
            terminationError = error;
          }
          await Promise.race([
            closure,
            new Promise((_, reject) => {
              cleanupTimer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Runtime import child cleanup UNKNOWN: PID ${child.pid} did not close within ${CHILD_CLEANUP_GRACE_MS}ms after termination`,
                      { cause: terminationError },
                    ),
                  ),
                CHILD_CLEANUP_GRACE_MS,
              );
            }),
          ]);
        }
      } finally {
        clearTimeout(cleanupTimer);
        child.removeListener("message", onMessage);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
      }
    },
  };
}

export async function collectDesignSystemRuntimeExports({
  rootDir = process.cwd(),
  entrypoint = "packages/design-system/src/index.ts",
  importRuntimeModule,
} = {}) {
  const entrypointUrl = pathToFileURL(path.resolve(rootDir, entrypoint)).href;
  const started = performance.now();
  const timeoutError = new Error(`Complete runtime import timed out after ${RUNTIME_IMPORT_DEADLINE_MS}ms`);
  let timer;
  let childImport;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), RUNTIME_IMPORT_DEADLINE_MS);
  });
  try {
    const result = importRuntimeModule
      ? Promise.resolve()
          .then(() => importRuntimeModule(entrypointUrl))
          .then(Object.keys)
      : (childImport = startRuntimeImportChild(rootDir, entrypointUrl)).result;
    const keys = await Promise.race([result, deadline]);
    if (performance.now() - started >= RUNTIME_IMPORT_DEADLINE_MS) throw timeoutError;
    return uniqueSorted(keys.filter((name) => name !== "default"));
  } finally {
    clearTimeout(timer);
    await childImport?.dispose();
  }
}

export async function runDesignSystemExportCoverageCheck({
  rootDir = process.cwd(),
  collectRuntimeExports = collectDesignSystemRuntimeExports,
  testedExports = TESTED_DESIGN_SYSTEM_ROOT_EXPORTS,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const runtimeExports = await collectRuntimeExports({ rootDir });
  const result = compareDesignSystemExportCoverage({ runtimeExports, testedExports });

  if (!result.passed) {
    stderr(formatDesignSystemExportCoverageFailure(result));
    return 1;
  }

  stdout(`Design-system export coverage guard passed (${result.actualExports.length} root exports covered).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === IMPORT_CHILD_FLAG) {
    let message;
    try {
      const namespace = await tsImport(process.argv[3], import.meta.url);
      message = { type: "design-system-runtime-exports", keys: Object.keys(namespace) };
    } catch (error) {
      message = {
        type: "design-system-runtime-exports",
        error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? "" },
      };
      process.exitCode = 1;
    }
    await new Promise((resolve, reject) => process.send(message, (error) => (error ? reject(error) : resolve())));
    process.disconnect();
  } else {
    process.exitCode = await runDesignSystemExportCoverageCheck();
  }
}

import type { CatalogProviderProfileEditableSectionKey } from "../api/provider-profile-section-registry";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview, CatalogProviderProfileVersionReview } from "./contracts";
import {
  arrayValue,
  booleanValue,
  recordValue,
  stringArrayValue,
  stringValue,
} from "./primary-workbench-read-model-support";

export type ProfileOptionQueryDetail =
  CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["optionQueries"][number];

const providerOptionQueryFreshTtlMinutes = 15;
const providerOptionQueryStaleTtlHours = 24;

export function profileSectionOptionQueries(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  overview: CatalogIntegrationControlPlaneOverview | null,
): readonly ProfileOptionQueryDetail[] {
  if (section !== "provider-options") {
    return [];
  }

  const profileRecord = recordValue(profile.profile);
  const cacheState = optionQueryCacheState(profile, overview);

  return arrayValue(profileRecord?.optionQueries)
    .map((value): ProfileOptionQueryDetail | null => {
      const record = recordValue(value);
      const output = recordValue(record?.output);
      const queryKind = stringValue(record?.queryKind);
      const displayName = stringValue(record?.displayName);
      const scope = stringValue(record?.scope);
      const operation = stringValue(record?.operation);
      if (!record || !queryKind || !displayName || !scope || !operation || !output) {
        return null;
      }
      const parentValue = recordValue(record.parentValue);

      return {
        queryKind,
        queryKeySynonyms: stringArrayValue(record.queryKeySynonyms),
        displayName,
        scope,
        parentScope: stringValue(record.parentScope),
        parentRequired: booleanValue(parentValue?.required) ?? false,
        parentValueKind: stringValue(parentValue?.valueKind),
        parentDiagnosticText: stringValue(parentValue?.diagnosticText),
        operation,
        outputMappings: optionQueryOutputMappings(output),
        cacheState,
      };
    })
    .filter((query): query is ProfileOptionQueryDetail => query !== null);
}

function optionQueryOutputMappings(output: Record<string, unknown>): ProfileOptionQueryDetail["outputMappings"] {
  const mappings: ProfileOptionQueryDetail["outputMappings"][number][] = [];
  addOutputMapping(mappings, "value", "Value", stringValue(output.valuePath));
  addOutputMapping(mappings, "label", "Label", stringValue(output.labelPath));
  const descriptionPath = optionQueryDescriptionSummary(output.description);
  addOutputMapping(mappings, "description", "Description", descriptionPath);
  addOutputMapping(mappings, "parent", "Parent value", stringValue(output.parentValuePath));
  addOutputMapping(mappings, "image", "Image", stringValue(output.imageUrlPath));
  for (const [index, path] of stringArrayValue(output.imageUrlCoalescePaths).entries()) {
    addOutputMapping(mappings, `image-coalesce-${index + 1}`, `Image fallback ${index + 1}`, path);
  }
  for (const [key, path] of Object.entries(recordValue(output.metadataPaths) ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    addOutputMapping(mappings, `metadata-${key}`, `Metadata: ${key}`, stringValue(path));
  }

  return mappings;
}

function addOutputMapping(
  mappings: ProfileOptionQueryDetail["outputMappings"][number][],
  key: string,
  label: string,
  path: string | null,
): void {
  if (path) {
    mappings.push({ key, label, path });
  }
}

function optionQueryDescriptionSummary(value: unknown): string | null {
  const description = recordValue(value);
  const kind = stringValue(description?.kind);
  if (!kind) {
    return null;
  }
  if (kind === "path") {
    return stringValue(description?.path);
  }

  return kind;
}

function optionQueryCacheState(
  profile: CatalogProviderProfileVersionReview,
  overview: CatalogIntegrationControlPlaneOverview | null,
): ProfileOptionQueryDetail["cacheState"] {
  const health = overview?.providerReadiness.providers.find(
    (provider) => provider.providerKey === profile.providerKey,
  )?.optionQueryHealth;
  const status = health?.status ?? "unknown";
  const diagnosticCodes = health?.diagnosticCodes ?? [];
  const cacheOnly =
    diagnosticCodes.some((code) => /cache-only/i.test(code)) || /cache-only/i.test(health?.message ?? "");
  const policy = `Fresh option-query results expire after ${providerOptionQueryFreshTtlMinutes} minutes; stale fallback expires after ${providerOptionQueryStaleTtlHours} hours.`;

  return {
    status,
    label:
      status === "ready"
        ? "Option queries ready"
        : status === "degraded"
          ? "Option queries degraded"
          : status === "blocked"
            ? "Option queries blocked"
            : "Option query health unknown",
    description: health?.message ? `${health.message} ${policy}` : policy,
    diagnosticCodes,
    freshTtlMinutes: providerOptionQueryFreshTtlMinutes,
    staleTtlHours: providerOptionQueryStaleTtlHours,
    cacheOnly,
  };
}

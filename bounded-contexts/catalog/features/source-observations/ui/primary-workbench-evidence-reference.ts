import type { CatalogPrimaryWorkbenchAuditEvidenceTargetType } from "../api/primary-workbench-admin-contracts";

export type CatalogEvidenceReference = Readonly<{
  kind: CatalogPrimaryWorkbenchAuditEvidenceTargetType | "provider" | "scope" | "candidate" | "alias";
  id: string;
  providerKey?: string;
}>;

const kinds = new Set([
  "provider",
  "scope",
  "candidate",
  "alias",
  "provider-profile",
  "import-job",
  "source-observation",
  "catalog-item",
  "control-plane",
]);

export function serializeCatalogEvidenceReference(reference: CatalogEvidenceReference): string {
  return [reference.kind, reference.id, ...(reference.providerKey ? [reference.providerKey] : [])]
    .map(encodeURIComponent)
    .join("/");
}

export function parseCatalogEvidenceReference(value: string | null | undefined): CatalogEvidenceReference | null {
  if (!value || value.length > 1200) return null;
  try {
    const [kind, id, providerKey, ...extra] = value.split("/").map(decodeURIComponent);
    if (
      !kind ||
      !kinds.has(kind) ||
      !id ||
      extra.length ||
      [id, ...(providerKey === undefined ? [] : [providerKey])].some(
        (part) => !part.trim() || part.length > 300 || /[\u0000-\u001f\u007f]/.test(part),
      ) ||
      (kind === "provider-profile" ? !providerKey : providerKey !== undefined)
    )
      return null;
    return { kind: kind as CatalogEvidenceReference["kind"], id, ...(providerKey ? { providerKey } : {}) };
  } catch {
    return null;
  }
}

export function catalogEntityEvidenceHref(location: string | URL, reference: CatalogEvidenceReference): string {
  const url = new URL(location, "https://admin.example");
  url.searchParams.set("evidenceRef", serializeCatalogEvidenceReference(reference));
  return `${url.pathname}${url.search}${url.hash}`;
}

import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type DiscoverySlugEntityKind = "category" | "item" | "listing" | "product" | "account" | "reference-record";

const ID_SUFFIX_LABEL_LENGTH = 24;

export function createSlugBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function hashId(id: string): string {
  let hash = 0x811c9dc5;

  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function compactIdSuffix(id: string): string {
  const suffix = createSlugBase(id).slice(-ID_SUFFIX_LABEL_LENGTH).replace(/^-+/, "");

  return `${suffix || "item"}-${hashId(id)}`;
}

export function createMarketplaceSlug(parts: readonly (string | null | undefined)[], id: string): string {
  const base = createSlugBase(parts.filter(Boolean).join(" ")) || "marketplace";

  return `${base}-${compactIdSuffix(id)}`;
}

export async function rememberSlugRedirect(
  db: PgQueryable,
  params: Readonly<{
    entityKind: DiscoverySlugEntityKind;
    entityId: string;
    previousSlug: string | null | undefined;
    nextSlug: string;
    updatedAt: string;
  }>,
): Promise<void> {
  if (!params.previousSlug || params.previousSlug === params.nextSlug) {
    return;
  }

  await db.query(
    `INSERT INTO discovery_slug_redirects (
       entity_kind,
       slug,
       entity_id,
       target_slug,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (entity_kind, slug) DO UPDATE SET
       entity_id = EXCLUDED.entity_id,
       target_slug = EXCLUDED.target_slug,
       updated_at = EXCLUDED.updated_at`,
    [params.entityKind, params.previousSlug, params.entityId, params.nextSlug, params.updatedAt],
  );
}

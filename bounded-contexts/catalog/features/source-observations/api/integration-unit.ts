export type CatalogIntegrationUnitKey = string;

export type CatalogIntegrationUnitIdentity = Readonly<{
  providerKey: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose?: string;
}>;

const integrationUnitSegmentPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function defineCatalogIntegrationUnitKey(identity: CatalogIntegrationUnitIdentity): CatalogIntegrationUnitKey {
  const segments = [
    identity.providerKey,
    identity.productDomain,
    identity.productForm,
    identity.ingestionPurpose,
  ].filter((segment): segment is string => Boolean(segment));

  for (const segment of segments) {
    if (!integrationUnitSegmentPattern.test(segment)) {
      throw new Error(`Invalid Catalog integration unit segment '${segment}'.`);
    }
  }

  if (segments.length < 3) {
    throw new Error("Catalog integration unit keys require provider, product domain, and product form.");
  }

  return segments.join(":");
}

export function parseCatalogIntegrationUnitKey(unitKey: CatalogIntegrationUnitKey): CatalogIntegrationUnitIdentity {
  const segments = unitKey.split(":");

  if (segments.length !== 3 && segments.length !== 4) {
    throw new Error(`Catalog integration unit key '${unitKey}' must have 3 or 4 segments.`);
  }

  const [providerKey, productDomain, productForm, ingestionPurpose] = segments;

  return {
    providerKey: requireIntegrationUnitSegment(providerKey, unitKey),
    productDomain: requireIntegrationUnitSegment(productDomain, unitKey),
    productForm: requireIntegrationUnitSegment(productForm, unitKey),
    ...(ingestionPurpose ? { ingestionPurpose: requireIntegrationUnitSegment(ingestionPurpose, unitKey) } : {}),
  };
}

function requireIntegrationUnitSegment(segment: string | undefined, unitKey: string): string {
  if (!segment || !integrationUnitSegmentPattern.test(segment)) {
    throw new Error(`Catalog integration unit key '${unitKey}' contains an invalid segment.`);
  }

  return segment;
}

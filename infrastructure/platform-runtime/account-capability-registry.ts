import {
  normalizeAccountCapabilityDeclaration,
  type BcAccountCapabilityDeclaration,
  type BcApiModule,
} from "@chase-sets/bounded-context-module";

export type AccountCapabilityRegistryEntry = Readonly<{ readonly owningContext: string }> &
  BcAccountCapabilityDeclaration;

export type AccountCapabilityRegistry = readonly AccountCapabilityRegistryEntry[];

export type AccountCapabilityModuleRegistration = Readonly<{
  readonly contextName: string;
  readonly module: Pick<BcApiModule, "accountCapabilities">;
}>;

export function buildAccountCapabilityRegistry(
  registrations: readonly AccountCapabilityModuleRegistration[],
): AccountCapabilityRegistry {
  if (!Array.isArray(registrations)) {
    throw new Error("Account Capability registry registrations must be an array.");
  }

  const entriesByKey = new Map<string, AccountCapabilityRegistryEntry>();

  for (const registration of registrations) {
    const declarations = registration.module.accountCapabilities;
    if (declarations === undefined) {
      continue;
    }
    if (!Array.isArray(declarations)) {
      throw new Error(`Context '${registration.contextName}' accountCapabilities must be an array.`);
    }

    for (const candidate of declarations) {
      const declaration = normalizeAccountCapabilityDeclaration(registration.contextName, candidate);
      const existing = entriesByKey.get(declaration.key);
      if (existing) {
        throw new Error(
          `Account capability '${declaration.key}' is declared by both '${existing.owningContext}' and '${registration.contextName}'.`,
        );
      }

      entriesByKey.set(declaration.key, freezeRegistryEntry(registration.contextName, declaration));
    }
  }

  return Object.freeze(
    [...entriesByKey.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
  );
}

function freezeRegistryEntry(
  owningContext: string,
  declaration: BcAccountCapabilityDeclaration,
): AccountCapabilityRegistryEntry {
  if (declaration.kind === "tier") {
    return Object.freeze({
      owningContext,
      key: declaration.key,
      description: declaration.description,
      kind: declaration.kind,
      allowedValues: Object.freeze([...declaration.allowedValues]),
      defaultValue: declaration.defaultValue,
    });
  }

  if (declaration.kind === "limit") {
    return Object.freeze({
      owningContext,
      key: declaration.key,
      description: declaration.description,
      kind: declaration.kind,
      defaultValue: declaration.defaultValue,
    });
  }

  return Object.freeze({
    owningContext,
    key: declaration.key,
    description: declaration.description,
    kind: declaration.kind,
    defaultValue: declaration.defaultValue,
  });
}

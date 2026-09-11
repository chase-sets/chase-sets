import type { ChannelConnectionSetupDeclaration } from "../../connections/domain/contracts";
import { assertClosedRecord, assertSetupDeclaration } from "../../connections/domain/validation";
import type {
  ChannelProviderDescriptor,
  ChannelProviderIdentity,
  ChannelProviderRegistry,
  ChannelPublicationCapability,
  ResolvedChannelProvider,
  ResolvedChannelPublication,
} from "../domain/contracts";
import {
  assertChannelProviderIdentity,
  assertChannelPublicationResult,
  assertDelistListingInput,
  assertPublishListingInput,
  assertUpdatePriceQuantityInput,
} from "../domain/validation";
import { ChannelConnectionError } from "../../connections/domain/contracts";
import { tcgplayerProviderDescriptors } from "../../tcgplayer-csv/domain/profile";

export function createChannelProviderRegistry(
  descriptors: readonly ChannelProviderDescriptor[],
): ChannelProviderRegistry {
  if (!Array.isArray(descriptors)) invalid("provider descriptors must be an array.");

  const providers = new Map<string, ResolvedChannelProvider>();
  for (const [index, descriptor] of descriptors.entries()) {
    const label = `provider descriptors[${index}]`;
    assertClosedRecord(descriptor, ["identity", "setup", "publication"], label);
    assertProviderIdentityAt(descriptor.identity, `${label}.identity`);
    assertSetupAt(descriptor.setup, descriptor.identity, `${label}.setup`);
    const key = identityKey(descriptor.identity);
    if (providers.has(key)) invalid(`${label}.identity duplicates a registered provider identity.`);

    const identity = freezeIdentity(descriptor.identity);
    const setup = freezeSetup(descriptor.setup);
    const publication = Object.hasOwn(descriptor, "publication")
      ? resolvePublication(descriptor.publication, `${label}.publication`)
      : null;
    providers.set(key, Object.freeze({ identity, setup, publication }));
  }

  const identities = Object.freeze(
    [...providers.values()]
      .map(({ identity }) => identity)
      .sort(
        (left, right) =>
          compareText(left.providerKey, right.providerKey) || compareText(left.environment, right.environment),
      ),
  );
  const get = (identity: ChannelProviderIdentity): ResolvedChannelProvider | null => {
    assertChannelProviderIdentity(identity);
    return providers.get(identityKey(identity)) ?? null;
  };
  const setupResolver = Object.freeze({
    resolve: async (identity: ChannelProviderIdentity) => get(identity)?.setup ?? null,
  });

  return Object.freeze({
    get,
    list: () => identities,
    setupResolver,
  });
}

const productionChannelProviderDescriptors: readonly ChannelProviderDescriptor[] = Object.freeze([
  ...tcgplayerProviderDescriptors,
]);

export const channelProviderRegistry: ChannelProviderRegistry = createChannelProviderRegistry(
  productionChannelProviderDescriptors,
);

function resolvePublication(value: unknown, label: string): ResolvedChannelPublication {
  assertClosedRecord(value, ["execution", "publishListing", "updatePriceQuantity", "delistListing"], label);
  if (value.execution === "claimed") {
    assertClosedRecord(value, ["execution"], label);
    return Object.freeze({ execution: "claimed" });
  }
  assertInlinePublicationCapability(value, label);
  const registeredMethods = Object.freeze({
    publishListing: value.publishListing,
    updatePriceQuantity: value.updatePriceQuantity,
    delistListing: value.delistListing,
  });
  return Object.freeze({
    execution: "inline",
    publishListing: async (input) => {
      assertPublishListingInput(input);
      const result = await registeredMethods.publishListing(input);
      assertChannelPublicationResult(result);
      return result;
    },
    updatePriceQuantity: async (input) => {
      assertUpdatePriceQuantityInput(input);
      const result = await registeredMethods.updatePriceQuantity(input);
      assertChannelPublicationResult(result);
      return result;
    },
    delistListing: async (input) => {
      assertDelistListingInput(input);
      const result = await registeredMethods.delistListing(input);
      assertChannelPublicationResult(result);
      return result;
    },
  });
}

function assertInlinePublicationCapability(
  value: unknown,
  label: string,
): asserts value is Extract<ChannelPublicationCapability, { execution: "inline" }> {
  assertClosedRecord(value, ["execution", "publishListing", "updatePriceQuantity", "delistListing"], label);
  if (value.execution !== "inline") invalid(`${label}.execution is invalid.`);
  if (typeof value.publishListing !== "function") invalid(`${label}.publishListing must be a function.`);
  if (typeof value.updatePriceQuantity !== "function") invalid(`${label}.updatePriceQuantity must be a function.`);
  if (typeof value.delistListing !== "function") invalid(`${label}.delistListing must be a function.`);
}

function freezeIdentity(identity: ChannelProviderIdentity): ChannelProviderIdentity {
  return Object.freeze({ providerKey: identity.providerKey, environment: identity.environment });
}

function freezeSetup(setup: ChannelConnectionSetupDeclaration): ChannelConnectionSetupDeclaration {
  return Object.freeze({
    providerKey: setup.providerKey,
    environment: setup.environment,
    requirements: Object.freeze({
      credential: setup.requirements.credential,
      requiredPolicyKeys: Object.freeze([...setup.requirements.requiredPolicyKeys]),
      binding: setup.requirements.binding,
    }),
  });
}

function identityKey(identity: ChannelProviderIdentity): string {
  return `${identity.providerKey}\u0000${identity.environment}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertProviderIdentityAt(value: unknown, path: string): asserts value is ChannelProviderIdentity {
  validateAt(path, () => assertChannelProviderIdentity(value, path));
}

function assertSetupAt(
  value: unknown,
  expected: ChannelProviderIdentity,
  path: string,
): asserts value is ChannelConnectionSetupDeclaration {
  validateAt(path, () => assertSetupDeclaration(value, expected));
}

function validateAt(path: string, validate: () => void): void {
  try {
    validate();
  } catch (error) {
    if (error instanceof ChannelConnectionError && error.code === "invalid-input") {
      invalid(`${path}: ${error.message}`);
    }
    throw error;
  }
}

function invalid(message: string): never {
  throw new ChannelConnectionError("invalid-input", message);
}

export const productionRuntimeModes = ["landing", "proof", "public"] as const;
export type ProductionRuntimeMode = (typeof productionRuntimeModes)[number];

export const platformApiRuntimeProfiles = ["landing", "proof", "public"] as const;
export type PlatformApiRuntimeProfile = (typeof platformApiRuntimeProfiles)[number];

export const platformWorkerRuntimeProfiles = ["landing", "proof", "public"] as const;
export type PlatformWorkerRuntimeProfile = (typeof platformWorkerRuntimeProfiles)[number];

export type RuntimeProfileKind = "platform-api" | "platform-worker";
export type RuntimeProfileName = PlatformApiRuntimeProfile | PlatformWorkerRuntimeProfile;

export type RuntimeProfileContract = Readonly<{
  kind: RuntimeProfileKind;
  profile: RuntimeProfileName;
  allowedProductionModes: readonly ProductionRuntimeMode[];
  mountedContextSet: "landing" | "full-platform";
  publicMarketplaceRoutes: boolean;
  privateProofRoutes: boolean;
  providerCallbacks: "landing-safe" | "private-proof" | "public-marketplace";
  workerGroups: readonly ("projection-fallback" | "projection-wake" | "provider-jobs" | "admin-support")[];
  requiredSecretPosture: "landing" | "proof" | "public";
  smokeExpectation: "landing-admin" | "private-marketplace-proof" | "public-marketplace";
}>;

export type RuntimeProfileSelection = Readonly<{
  productionMode: ProductionRuntimeMode;
  apiProfile: PlatformApiRuntimeProfile;
  workerProfile: PlatformWorkerRuntimeProfile;
}>;

export type RuntimeProfileValidationResult = Readonly<{
  valid: boolean;
  errors: readonly string[];
}>;

const runtimeProfileContracts = [
  {
    kind: "platform-api",
    profile: "landing",
    allowedProductionModes: ["landing"],
    mountedContextSet: "landing",
    publicMarketplaceRoutes: false,
    privateProofRoutes: false,
    providerCallbacks: "landing-safe",
    workerGroups: [],
    requiredSecretPosture: "landing",
    smokeExpectation: "landing-admin",
  },
  {
    kind: "platform-api",
    profile: "proof",
    allowedProductionModes: ["proof"],
    mountedContextSet: "full-platform",
    publicMarketplaceRoutes: false,
    privateProofRoutes: true,
    providerCallbacks: "private-proof",
    workerGroups: [],
    requiredSecretPosture: "proof",
    smokeExpectation: "private-marketplace-proof",
  },
  {
    kind: "platform-api",
    profile: "public",
    allowedProductionModes: ["public"],
    mountedContextSet: "full-platform",
    publicMarketplaceRoutes: true,
    privateProofRoutes: true,
    providerCallbacks: "public-marketplace",
    workerGroups: [],
    requiredSecretPosture: "public",
    smokeExpectation: "public-marketplace",
  },
  {
    kind: "platform-worker",
    profile: "landing",
    allowedProductionModes: ["landing"],
    mountedContextSet: "landing",
    publicMarketplaceRoutes: false,
    privateProofRoutes: false,
    providerCallbacks: "landing-safe",
    workerGroups: ["admin-support"],
    requiredSecretPosture: "landing",
    smokeExpectation: "landing-admin",
  },
  {
    kind: "platform-worker",
    profile: "proof",
    allowedProductionModes: ["proof"],
    mountedContextSet: "full-platform",
    publicMarketplaceRoutes: false,
    privateProofRoutes: true,
    providerCallbacks: "private-proof",
    workerGroups: ["projection-fallback", "projection-wake", "provider-jobs", "admin-support"],
    requiredSecretPosture: "proof",
    smokeExpectation: "private-marketplace-proof",
  },
  {
    kind: "platform-worker",
    profile: "public",
    allowedProductionModes: ["public"],
    mountedContextSet: "full-platform",
    publicMarketplaceRoutes: true,
    privateProofRoutes: true,
    providerCallbacks: "public-marketplace",
    workerGroups: ["projection-fallback", "projection-wake", "provider-jobs", "admin-support"],
    requiredSecretPosture: "public",
    smokeExpectation: "public-marketplace",
  },
] as const satisfies readonly RuntimeProfileContract[];

export function isProductionRuntimeMode(value: string): value is ProductionRuntimeMode {
  return includesString(productionRuntimeModes, value);
}

export function isPlatformApiRuntimeProfile(value: string): value is PlatformApiRuntimeProfile {
  return includesString(platformApiRuntimeProfiles, value);
}

export function isPlatformWorkerRuntimeProfile(value: string): value is PlatformWorkerRuntimeProfile {
  return includesString(platformWorkerRuntimeProfiles, value);
}

export function runtimeProfileContract(
  kind: "platform-api",
  profile: PlatformApiRuntimeProfile,
): RuntimeProfileContract;
export function runtimeProfileContract(
  kind: "platform-worker",
  profile: PlatformWorkerRuntimeProfile,
): RuntimeProfileContract;
export function runtimeProfileContract(kind: RuntimeProfileKind, profile: RuntimeProfileName) {
  const contract = runtimeProfileContracts.find((entry) => entry.kind === kind && entry.profile === profile);
  if (!contract) {
    throw new Error(`Unknown ${kind} runtime profile '${profile}'.`);
  }
  return contract;
}

export function validateRuntimeProfileSelection(input: {
  productionMode: string;
  apiProfile: string;
  workerProfile: string;
}): RuntimeProfileValidationResult {
  const errors: string[] = [];

  if (!isProductionRuntimeMode(input.productionMode)) {
    errors.push(
      `Unknown production runtime mode '${input.productionMode}'. Expected one of: ${productionRuntimeModes.join(", ")}.`,
    );
  }
  if (!isPlatformApiRuntimeProfile(input.apiProfile)) {
    errors.push(
      `Unknown platform-api runtime profile '${input.apiProfile}'. Expected one of: ${platformApiRuntimeProfiles.join(", ")}.`,
    );
  }
  if (!isPlatformWorkerRuntimeProfile(input.workerProfile)) {
    errors.push(
      `Unknown platform-worker runtime profile '${input.workerProfile}'. Expected one of: ${platformWorkerRuntimeProfiles.join(", ")}.`,
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const selection = input as RuntimeProfileSelection;
  for (const contract of [
    runtimeProfileContract("platform-api", selection.apiProfile),
    runtimeProfileContract("platform-worker", selection.workerProfile),
  ]) {
    if (!contract.allowedProductionModes.includes(selection.productionMode)) {
      errors.push(
        `${contract.kind} profile '${contract.profile}' is not valid for production mode '${selection.productionMode}'.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function requireValidRuntimeProfileSelection(input: {
  productionMode: string;
  apiProfile: string;
  workerProfile: string;
}): RuntimeProfileSelection {
  const result = validateRuntimeProfileSelection(input);
  if (!result.valid) {
    throw new Error(`Invalid runtime profile selection: ${result.errors.join(" ")}`);
  }

  return input as RuntimeProfileSelection;
}

function includesString<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

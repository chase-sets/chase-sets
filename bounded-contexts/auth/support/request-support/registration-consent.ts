import {
  createIdentityAuthRequestClient,
  type RegistrationConsentBundleSnapshot,
  type RegistrationConsentSubmission,
} from "@chase-sets/identity/server";

export type RegistrationConsentResolution = Readonly<{
  operationId: string;
  snapshot: RegistrationConsentBundleSnapshot;
}>;

export function resolveRegistrationConsentForRequest(request: Request) {
  return createIdentityAuthRequestClient(request).resolveRegistrationConsent();
}

export function serializeRegistrationConsentResolution(resolution: RegistrationConsentResolution) {
  return JSON.stringify(resolution);
}

export function registrationConsentSubmission(value: unknown, affirmed?: boolean): RegistrationConsentSubmission {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!parsed || typeof parsed !== "object") {
    return {
      operationId: "",
      snapshot: { bundleKey: "registration", requirements: [] },
      affirmed: affirmed === true,
    };
  }
  const resolution = parsed as Partial<RegistrationConsentResolution>;
  return {
    operationId: typeof resolution.operationId === "string" ? resolution.operationId : "",
    snapshot:
      resolution.snapshot?.bundleKey === "registration" && Array.isArray(resolution.snapshot.requirements)
        ? resolution.snapshot
        : { bundleKey: "registration", requirements: [] },
    affirmed: affirmed ?? (parsed as { affirmed?: unknown }).affirmed === true,
  };
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

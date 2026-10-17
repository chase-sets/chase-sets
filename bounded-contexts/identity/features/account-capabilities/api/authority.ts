import { createHash } from "node:crypto";

export type CapabilityAdministrationAuthority =
  | Readonly<{ kind: "deny-all"; diagnostic: "authority_absent" | "authority_invalid" }>
  | Readonly<{
      kind: "configured";
      version: 1;
      environment: string;
      deploymentInstance: string;
      authorityId: string;
      revision: number;
      adminUserIds: readonly string[];
      configDigest: string;
      implementationSha: string;
    }>;

export const DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY: CapabilityAdministrationAuthority = Object.freeze({
  kind: "deny-all",
  diagnostic: "authority_absent",
});
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const userId = /^usr_[A-Za-z0-9_]{1,128}$/;

function validInstance(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 170) return false;
  try {
    const tuple: unknown = JSON.parse(value);
    return (
      Array.isArray(tuple) &&
      tuple.length === 3 &&
      tuple[0] === "support-deployment-instance/v1" &&
      tuple.slice(1).every((part) => typeof part === "string" && dnsLabel.test(part)) &&
      JSON.stringify(tuple) === value
    );
  } catch {
    return false;
  }
}

export function parseCapabilityAdministrationAuthority(
  raw: string | undefined,
  scope: Readonly<{
    environment: string;
    deploymentInstance: string | undefined;
    implementationSha: string | undefined;
  }>,
): CapabilityAdministrationAuthority {
  if (!raw) return DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY;
  const invalid: CapabilityAdministrationAuthority = { kind: "deny-all", diagnostic: "authority_invalid" };
  if (
    Buffer.byteLength(raw, "utf8") > 4096 ||
    !validInstance(scope.deploymentInstance) ||
    !scope.implementationSha ||
    !/^[a-f0-9]{40}$/.test(scope.implementationSha)
  )
    return invalid;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
    const fields = ["version", "environment", "deploymentInstance", "authorityId", "revision", "adminUserIds"];
    if (Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key)))
      return invalid;
    const v = value as Record<string, unknown>;
    if (
      v.version !== 1 ||
      !["dev", "local", "remote-dev", "test", "preview", "staging", "production"].includes(String(v.environment)) ||
      v.environment !== scope.environment ||
      !validInstance(v.deploymentInstance) ||
      v.deploymentInstance !== scope.deploymentInstance ||
      typeof v.authorityId !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(v.authorityId) ||
      typeof v.revision !== "number" ||
      !Number.isInteger(v.revision) ||
      v.revision < 1 ||
      v.revision > 2147483647 ||
      !Array.isArray(v.adminUserIds) ||
      v.adminUserIds.length > 16 ||
      !v.adminUserIds.every((id: unknown) => typeof id === "string" && userId.test(id)) ||
      new Set(v.adminUserIds).size !== v.adminUserIds.length
    )
      return invalid;
    const effective = {
      version: 1 as const,
      environment: scope.environment,
      deploymentInstance: scope.deploymentInstance,
      authorityId: v.authorityId,
      revision: v.revision,
      adminUserIds: Object.freeze([...v.adminUserIds].sort()) as readonly string[],
    };
    return Object.freeze({
      kind: "configured",
      ...effective,
      configDigest: `sha256:${createHash("sha256").update(JSON.stringify(effective)).digest("hex")}`,
      implementationSha: scope.implementationSha,
    });
  } catch {
    return invalid;
  }
}

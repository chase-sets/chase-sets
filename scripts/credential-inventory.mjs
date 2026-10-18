// Credential inventory: one entry per GitHub Actions secret name set in the
// repository or any environment, plus the names workflows reference but
// deliberately leave unset (`optional`). Terms and rotation kinds are defined
// in docs/runbooks/credential-rotation.md. This module only reads names and
// inventory metadata; it never handles a secret value.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

export const CREDENTIAL_INVENTORY_PATH = ".github/credential-inventory.json";
export const REPOSITORY_SCOPE = "repository";
export const ENTRY_KINDS = Object.freeze(["credential", "identifier"]);
export const ROTATION_KINDS = Object.freeze(["automatic", "assisted", "external-owner"]);
export const LIVENESS_KINDS = Object.freeze([
  "digitalocean-account",
  "github-token",
  "spaces-bucket",
  "spaces-list-buckets",
]);
export const SPACES_LIVENESS_KINDS = Object.freeze(["spaces-bucket", "spaces-list-buckets"]);
export const ASSISTED_MAX_AGE_DAYS = 365;

const ENTRY_KEYS = new Set([
  "name",
  "scope",
  "valueGroups",
  "kind",
  "rotation",
  "owner",
  "providerExpiryDays",
  "maxAgeDays",
  "liveness",
  "pairedWith",
  "proofWorkflows",
  "optional",
]);
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;
// `steps.runtime_secrets.outcome` and `steps.secrets.outputs` are not secret
// references, so the context name must not follow a word character or a dot.
const SECRET_REFERENCE = /(?<![\w.-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
const SECRET_INDEX = /(?<![\w.-])secrets\s*\[/;
const IMPLICIT_SECRETS = new Set(["GITHUB_TOKEN"]);
const SCANNED_ROOTS = [".github/workflows", ".github/actions"];

export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((member) => right.includes(member));
}

// Returns `{ errors, inventory }`. `inventory` is null when any error exists;
// otherwise every entry carries its normalized `scope` list and `valueGroups`.
export function validateCredentialInventory(value) {
  const errors = [];
  if (!plainObject(value) || value.schemaVersion !== 1) {
    return { errors: ["inventory must be an object with schemaVersion 1"], inventory: null };
  }
  const environments = value.environments;
  if (
    !Array.isArray(environments) ||
    environments.length === 0 ||
    environments.some(
      (name) => typeof name !== "string" || !ENVIRONMENT_NAME.test(name) || name === REPOSITORY_SCOPE,
    ) ||
    new Set(environments).size !== environments.length
  ) {
    errors.push("environments must be a non-empty list of unique environment names");
  }
  if (!Array.isArray(value.secrets) || value.secrets.length === 0) {
    errors.push("secrets must be a non-empty list");
    return { errors, inventory: null };
  }
  const knownScopes = new Set([REPOSITORY_SCOPE, ...(Array.isArray(environments) ? environments : [])]);
  const names = value.secrets.map((entry) => (plainObject(entry) ? entry.name : undefined));
  const byName = new Map();
  for (const [index, entry] of value.secrets.entries()) {
    const label = typeof entry?.name === "string" ? entry.name : `secrets[${index}]`;
    if (!plainObject(entry)) {
      errors.push(`${label}: entry must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) errors.push(`${label}: unknown key ${key}`);
    }
    if (typeof entry.name !== "string" || !SECRET_NAME.test(entry.name) || entry.name.startsWith("GITHUB_")) {
      errors.push(`${label}: name must be a GitHub secret name`);
      continue;
    }
    if (byName.has(entry.name)) errors.push(`${label}: duplicate entry`);
    if (index > 0 && typeof names[index - 1] === "string" && names[index - 1] >= entry.name) {
      errors.push(`${label}: entries must be sorted by name`);
    }
    byName.set(entry.name, entry);
    validateEntry(entry, label, knownScopes, errors);
  }
  for (const entry of byName.values()) {
    for (const partner of Array.isArray(entry.pairedWith) ? entry.pairedWith : []) {
      const other = byName.get(partner);
      if (!other) errors.push(`${entry.name}: pairedWith ${partner} has no entry`);
      else if (!Array.isArray(other.pairedWith) || !other.pairedWith.includes(entry.name)) {
        errors.push(`${entry.name}: pairedWith ${partner} is not reciprocated`);
      }
    }
    if (SPACES_LIVENESS_KINDS.includes(entry.liveness?.kind)) {
      const partner = byName.get(entry.pairedWith?.[0]);
      if (entry.pairedWith?.length !== 1 || !partner) {
        errors.push(`${entry.name}: Spaces liveness needs exactly one pairedWith secret key`);
      } else if (
        partner.liveness !== null ||
        !sameMembers(normalizedScope(partner.scope), normalizedScope(entry.scope))
      ) {
        errors.push(
          `${entry.name}: Spaces liveness partner ${partner.name} must share its scope and carry no liveness`,
        );
      }
    }
  }
  if (errors.length > 0) return { errors, inventory: null };
  const entries = value.secrets.map((entry) => {
    const scope = normalizedScope(entry.scope);
    return {
      ...entry,
      scope,
      valueGroups: entry.valueGroups ?? scope.map((member) => [member]),
      optional: entry.optional === true,
    };
  });
  return {
    errors,
    inventory: {
      environments: [...environments],
      scopes: [REPOSITORY_SCOPE, ...environments],
      entries,
      byName: new Map(entries.map((entry) => [entry.name, entry])),
    },
  };
}

function normalizedScope(scope) {
  return scope === REPOSITORY_SCOPE ? [REPOSITORY_SCOPE] : Array.isArray(scope) ? scope : [];
}

function validateEntry(entry, label, knownScopes, errors) {
  const scope = entry.scope;
  if (
    !(scope === REPOSITORY_SCOPE) &&
    !(
      Array.isArray(scope) &&
      scope.length > 0 &&
      scope.every((member) => knownScopes.has(member)) &&
      new Set(scope).size === scope.length
    )
  ) {
    errors.push(`${label}: scope must be "repository" or a list of inventoried environments`);
  }
  if (entry.valueGroups !== undefined) {
    const members = normalizedScope(scope);
    const groups = entry.valueGroups;
    const flat = Array.isArray(groups) ? groups.flat() : [];
    if (
      !Array.isArray(groups) ||
      groups.some((group) => !Array.isArray(group) || group.length === 0) ||
      new Set(flat).size !== flat.length ||
      !sameMembers(flat, members)
    ) {
      errors.push(`${label}: valueGroups must partition scope without overlap`);
    }
  }
  if (!ENTRY_KINDS.includes(entry.kind)) errors.push(`${label}: kind must be credential or identifier`);
  if (!ROTATION_KINDS.includes(entry.rotation)) {
    errors.push(`${label}: rotation must be automatic, assisted or external-owner`);
  }
  if ((entry.rotation === "external-owner") !== isPositiveInteger(entry.owner)) {
    errors.push(`${label}: owner issue is required for external-owner rotation and only there`);
  }
  if (entry.providerExpiryDays !== null && !isPositiveInteger(entry.providerExpiryDays)) {
    errors.push(`${label}: providerExpiryDays must be a positive integer or null`);
  }
  if (entry.maxAgeDays !== null && !isPositiveInteger(entry.maxAgeDays)) {
    errors.push(`${label}: maxAgeDays must be a positive integer or null`);
  }
  if (entry.kind === "identifier") {
    if (entry.maxAgeDays !== null || entry.providerExpiryDays !== null) {
      errors.push(`${label}: identifier entries carry no age limit or provider expiry`);
    }
    if (entry.liveness !== null) errors.push(`${label}: identifier entries carry no liveness`);
  } else if (entry.kind === "credential") {
    if (!isPositiveInteger(entry.maxAgeDays)) errors.push(`${label}: credentials need maxAgeDays`);
    else if (entry.rotation === "assisted" && entry.maxAgeDays !== ASSISTED_MAX_AGE_DAYS) {
      errors.push(`${label}: assisted credentials use maxAgeDays ${ASSISTED_MAX_AGE_DAYS}`);
    }
  }
  const liveness = entry.liveness;
  if (liveness !== null) {
    if (
      !plainObject(liveness) ||
      !LIVENESS_KINDS.includes(liveness.kind) ||
      Object.keys(liveness).some((key) => key !== "kind" && key !== "bucket")
    ) {
      errors.push(`${label}: liveness must be null or { kind, bucket? } with a known kind`);
    } else if ((liveness.kind === "spaces-bucket") !== (liveness.bucket !== undefined)) {
      errors.push(`${label}: liveness bucket is required for spaces-bucket and only there`);
    } else if (liveness.bucket !== undefined && !BUCKET_NAME.test(liveness.bucket)) {
      errors.push(`${label}: liveness bucket is not a bucket name`);
    }
  }
  if (
    !Array.isArray(entry.pairedWith) ||
    entry.pairedWith.some((name) => typeof name !== "string" || name === entry.name) ||
    new Set(entry.pairedWith).size !== entry.pairedWith.length
  ) {
    errors.push(`${label}: pairedWith must list other secret names`);
  }
  if (
    !Array.isArray(entry.proofWorkflows) ||
    entry.proofWorkflows.some((file) => typeof file !== "string" || !WORKFLOW_FILE.test(file)) ||
    new Set(entry.proofWorkflows).size !== entry.proofWorkflows.length
  ) {
    errors.push(`${label}: proofWorkflows must list workflow file names`);
  }
  if (entry.optional !== undefined && entry.optional !== true) errors.push(`${label}: optional may only be true`);
}

// Scans workflow and composite-action sources ({ file, source }) for secret
// references. Index syntax hides the name from every static check, so it is
// rejected outright.
export function checkInventoryAgainstWorkflowSources(inventory, files) {
  const errors = [];
  const referencing = new Map();
  for (const { file, source } of files) {
    source.split(/\r?\n/).forEach((line, index) => {
      if (SECRET_INDEX.test(line)) errors.push(`${file}:${index + 1}: secrets[...] index syntax is not allowed`);
    });
    for (const match of source.matchAll(SECRET_REFERENCE)) {
      const name = match[1];
      if (IMPLICIT_SECRETS.has(name)) continue;
      if (!referencing.has(name)) referencing.set(name, new Set());
      referencing.get(name).add(file);
    }
  }
  for (const [name, referencedBy] of [...referencing].sort(([left], [right]) => left.localeCompare(right))) {
    if (!inventory.byName.has(name)) {
      errors.push(
        `${name}: referenced by ${[...referencedBy].sort().join(", ")} but has no credential inventory entry`,
      );
    }
  }
  for (const entry of inventory.entries) {
    if (entry.optional && !referencing.has(entry.name)) {
      errors.push(`${entry.name}: optional entries are for referenced names, but no workflow references it`);
    }
    for (const workflow of entry.proofWorkflows) {
      if (!referencing.get(entry.name)?.has(`.github/workflows/${workflow}`)) {
        errors.push(`${entry.name}: proof workflow ${workflow} does not reference this secret`);
      }
    }
  }
  return errors;
}

export function readWorkflowSources(root) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        files.push({ file: relative(root, path).split("\\").join("/"), source: readFileSync(path, "utf8") });
      }
    }
  };
  for (const scanned of SCANNED_ROOTS) walk(resolve(root, scanned));
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

export function loadCredentialInventory(root = process.cwd()) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(root, CREDENTIAL_INVENTORY_PATH), "utf8"));
  } catch {
    throw new Error(`${CREDENTIAL_INVENTORY_PATH} is missing or not valid JSON`);
  }
  const { errors, inventory } = validateCredentialInventory(value);
  if (errors.length > 0) throw new Error(`Credential inventory is invalid: ${errors.join("; ")}`);
  return inventory;
}

// The repository check run by test:scripts: a valid inventory that names every
// secret the workflows and actions reference.
export function checkCredentialInventory(root = process.cwd()) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(root, CREDENTIAL_INVENTORY_PATH), "utf8"));
  } catch {
    return [`${CREDENTIAL_INVENTORY_PATH} is missing or not valid JSON`];
  }
  const { errors, inventory } = validateCredentialInventory(value);
  if (!inventory) return errors;
  return checkInventoryAgainstWorkflowSources(inventory, readWorkflowSources(root));
}

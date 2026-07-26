import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../lib/repo.mjs";

// The identity-creation path registry: every currently-shipping position that
// can create an Account, User, or Membership, each carrying one disposition.
//
// It exists because the defect this repo keeps re-buying is an *incomplete
// caller inventory* -- a sibling path nobody listed, forwarding nothing, while
// its four neighbours forward correctly. A registry does not stop that on its
// own; the required, non-forgeable constructor parameter does. What the
// registry adds is a written decision per position, so a path that is
// deliberately not bound is distinguishable from a path nobody looked at.
//
// Data, not code, per the check-structure convention (mirrors ia-registry.json).
//
// The schema is validated as well as applied. `additionalProperties: false` at
// the top level of a schema whose nested objects are open is the classic
// shallow-closure bug: it reads as closed, passes its own fixtures, and admits
// anything one level down. `collectOpenSchemaObjectPaths` walks the schema
// itself and reports every object node that fails to declare closure, so the
// registry's guarantee is checked rather than assumed.

export const identityCreationPathRegistryPath = "scripts/check-structure/identity-creation-path-registry.json";
export const identityCreationPathRegistrySchemaPath =
  "scripts/check-structure/identity-creation-path-registry.schema.json";

export const identityCreationDispositions = new Set(["bound", "exempt-permanent", "exempt-temporary"]);

function readJson(rootDir, relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

export function loadIdentityCreationPathRegistry(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.registryPath ?? identityCreationPathRegistryPath);
}

export function loadIdentityCreationPathRegistrySchema(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.schemaPath ?? identityCreationPathRegistrySchemaPath);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every object node in the schema that does not declare `additionalProperties:
 * false`. An empty result is what "recursively closed" means here.
 */
export function collectOpenSchemaObjectPaths(schema, pointer = "#") {
  const open = [];
  if (!isPlainObject(schema)) {
    return open;
  }

  if (schema.type === "object" && schema.additionalProperties !== false) {
    open.push(pointer);
  }

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    open.push(...collectOpenSchemaObjectPaths(property, `${pointer}/properties/${name}`));
  }
  if (schema.items) {
    open.push(...collectOpenSchemaObjectPaths(schema.items, `${pointer}/items`));
  }

  return open;
}

/**
 * A deliberately small JSON Schema evaluator covering exactly the keywords this
 * schema uses. Hand-rolled because the repo carries no schema validator, and a
 * validator that silently ignores an unsupported keyword would reintroduce the
 * shallow-validation defect it exists to prevent -- so an unrecognised keyword
 * is reported as a violation rather than skipped.
 */
const supportedSchemaKeywords = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "additionalProperties",
  "required",
  "properties",
  "items",
  "enum",
  "minLength",
  "minItems",
  "minimum",
  "pattern",
]);

export function validateAgainstSchema(value, schema, pointer = "") {
  const violations = [];
  const label = pointer || "<root>";

  for (const keyword of Object.keys(schema)) {
    if (!supportedSchemaKeywords.has(keyword)) {
      violations.push(`${label}: schema uses unsupported keyword "${keyword}"`);
    }
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      violations.push(`${label}: expected an object`);
      return violations;
    }
    for (const required of schema.required ?? []) {
      if (!(required in value)) {
        violations.push(`${label}: missing required member "${required}"`);
      }
    }
    for (const key of Object.keys(value)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) {
          violations.push(`${label}: unknown member "${key}"`);
        }
        continue;
      }
      violations.push(...validateAgainstSchema(value[key], property, `${label}/${key}`));
    }
    return violations;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      violations.push(`${label}: expected an array`);
      return violations;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      violations.push(`${label}: expected at least ${schema.minItems} item(s)`);
    }
    value.forEach((entry, index) => {
      violations.push(...validateAgainstSchema(entry, schema.items, `${label}[${index}]`));
    });
    return violations;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      violations.push(`${label}: expected a string`);
      return violations;
    }
    if (typeof schema.minLength === "number" && value.trim().length < schema.minLength) {
      violations.push(`${label}: expected a non-empty string`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      violations.push(`${label}: does not match ${schema.pattern}`);
    }
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      violations.push(`${label}: expected an integer`);
      return violations;
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      violations.push(`${label}: expected at least ${schema.minimum}`);
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    violations.push(`${label}: expected one of ${schema.enum.join(", ")}`);
  }

  return violations;
}

/** Every registry entry, paths and composition members alike, as one flat list. */
export function listIdentityCreationEntries(registry) {
  return [...registry.paths, ...registry.compositions];
}

export function collectIdentityCreationRegistryViolations(registry, schema) {
  const violations = validateAgainstSchema(registry, schema);
  const seenIds = new Set();

  for (const entry of listIdentityCreationEntries(registry)) {
    if (seenIds.has(entry.id)) {
      violations.push(`${entry.id}: duplicate registry id`);
    }
    seenIds.add(entry.id);

    if (!entry.reason || !entry.reason.trim()) {
      violations.push(`${entry.id}: every entry needs a reason`);
    }
    if (entry.disposition === "exempt-temporary" && typeof entry.owningIssue !== "number") {
      violations.push(`${entry.id}: every temporary exemption must name an owning issue`);
    }
    if (entry.disposition !== "exempt-temporary" && entry.owningIssue !== undefined) {
      violations.push(`${entry.id}: only a temporary exemption carries an owning issue`);
    }
  }

  return violations;
}

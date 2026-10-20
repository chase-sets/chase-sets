import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_ROOT = fileURLToPath(new URL("./__fixtures__/ucp-2026-08-25/schemas/", import.meta.url));
const SCHEMA_PREFIX = "https://ucp.dev/2026-08-25/schemas/";
let state: { ajv: Ajv2020; unresolved: string[] } | undefined;

function schemaFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? schemaFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((item) => collectRefs(item, refs));
  for (const [key, child] of Object.entries(value)) {
    if ((key === "$ref" || key === "$dynamicRef") && typeof child === "string" && child.startsWith(SCHEMA_PREFIX)) refs.add(child);
    else collectRefs(child, refs);
  }
}

function loadSchemas() {
  if (state) return state;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const path of schemaFiles(SCHEMA_ROOT)) {
    const schema = JSON.parse(readFileSync(path, "utf8")) as AnySchema;
    const id = typeof schema === "object" && schema !== null && typeof schema.$id === "string" ? schema.$id : undefined;
    if (!id || !id.startsWith(SCHEMA_PREFIX)) throw new Error(`vendored schema is missing a dated $id: ${path}`);
    ajv.addSchema(schema, id);
    ids.add(id);
    collectRefs(schema, refs);
  }
  const unresolved = [...refs].filter((ref) => ![...ids].some((id) => ref === id || ref.startsWith(`${id}#`))).sort();
  state = { ajv, unresolved };
  return state;
}

export function ucpSchemaValidator(ref: string): ValidateFunction {
  const validator = loadSchemas().ajv.getSchema(ref);
  if (!validator) throw new Error(`unknown vendored UCP schema: ${ref}`);
  return validator;
}

export function compileUcpSchema(schema: AnySchema): ValidateFunction {
  return loadSchemas().ajv.compile(schema);
}

export function unresolvedUcpRefs(): readonly string[] {
  return loadSchemas().unresolved;
}

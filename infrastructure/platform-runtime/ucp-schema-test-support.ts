import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ucpErrorSeverity } from "./ucp-contracts";
import { ucpToolOutputSchema } from "./ucp-tool-schemas";

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
    if ((key === "$ref" || key === "$dynamicRef") && typeof child === "string" && child.startsWith(SCHEMA_PREFIX))
      refs.add(child);
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

type UcpCaptureKind = "resource" | "error";

const SCHEMA_BASE = "https://ucp.dev/2026-08-25/schemas/";
const RESOURCE_SCHEMAS: Readonly<Record<string, string>> = {
  search_catalog: `${SCHEMA_BASE}shopping/catalog_search.json#/$defs/search_response`,
  lookup_catalog: `${SCHEMA_BASE}shopping/catalog_lookup.json#/$defs/lookup_response`,
  get_product: `${SCHEMA_BASE}shopping/catalog_lookup.json#/$defs/get_product_response`,
  create_checkout: `${SCHEMA_BASE}shopping/checkout.json`,
  get_checkout: `${SCHEMA_BASE}shopping/checkout.json`,
  update_checkout: `${SCHEMA_BASE}shopping/checkout.json`,
  complete_checkout: `${SCHEMA_BASE}shopping/checkout.json`,
  cancel_checkout: `${SCHEMA_BASE}shopping/checkout.json`,
  get_order: `${SCHEMA_BASE}shopping/order.json`,
};
const ERROR_SCHEMA = `${SCHEMA_BASE}common/types/error_response.json`;

export function expectUcpCapture(
  capture: unknown,
  options: Readonly<{ operation: string; kind: UcpCaptureKind }>,
): Record<string, unknown> {
  if (!capture || typeof capture !== "object" || Array.isArray(capture))
    throw new Error("UCP capture is not an object");
  const parsed = capture as Record<string, unknown>;
  const pinnedRef = options.kind === "error" ? ERROR_SCHEMA : RESOURCE_SCHEMAS[options.operation];
  if (!pinnedRef) throw new Error(`No pinned UCP resource schema for ${options.operation}`);
  const pinned = ucpSchemaValidator(pinnedRef);
  if (!pinned(parsed))
    throw new Error(`Pinned UCP schema failed for ${options.operation}: ${JSON.stringify(pinned.errors)}`);
  const served = compileUcpSchema(ucpToolOutputSchema(options.operation as never));
  if (!served(parsed))
    throw new Error(`Served UCP schema failed for ${options.operation}: ${JSON.stringify(served.errors)}`);
  const envelope = parsed.ucp;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("UCP envelope is missing");
  const ucp = envelope as Record<string, unknown>;
  if (ucp.version !== "2026-08-25" || !["success", "error"].includes(String(ucp.status)))
    throw new Error("UCP version/status is invalid");
  if (options.kind === "resource" && ucp.status === "success") {
    if (
      Object.prototype.hasOwnProperty.call(parsed, "action") &&
      !Object.prototype.hasOwnProperty.call(parsed, "continue_url")
    )
      throw new Error("UCP handoff action requires continue_url");
    if (Array.isArray(parsed.totals) && parsed.totals.length === 0) throw new Error("UCP totals must not be empty");
    const lineItems = parsed.line_items;
    if (Array.isArray(lineItems)) {
      for (const line of lineItems as Record<string, unknown>[]) {
        const price = line.price;
        if (price && typeof price === "object" && Number((price as Record<string, unknown>).amount) <= 0)
          throw new Error("UCP line item price must be positive");
      }
    }
  }
  const messages = parsed.messages;
  if (options.kind === "error" && !Array.isArray(messages)) throw new Error("UCP error response requires messages");
  if (
    messages !== undefined &&
    (!Array.isArray(messages) || messages.some((message) => !message || typeof message !== "object"))
  )
    throw new Error("UCP messages are invalid");
  for (const message of (messages ?? []) as Record<string, unknown>[]) {
    const type = message.type;
    const code = String(message.code ?? "");
    if (type === "error" && message.severity !== ucpErrorSeverity(code))
      throw new Error(`UCP error severity mismatch for ${code}`);
    if ((type === "warning" || type === "info") && Object.prototype.hasOwnProperty.call(message, "severity"))
      throw new Error(`UCP ${type} unexpectedly carries severity for ${code}`);
    if (typeof message.content !== "string" || !message.content.trim())
      throw new Error(`UCP ${code} has empty content`);
    if (/ECONNREFUSED|Error:\s|stack\s*trace/i.test(message.content))
      throw new Error(`UCP ${code} leaked exception text`);
    if (message.path !== undefined && (typeof message.path !== "string" || !message.path.startsWith("$")))
      throw new Error(`UCP ${code} path is not JSONPath`);
  }
  return parsed;
}

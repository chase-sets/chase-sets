import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderMappingRuntimeFunctionKey,
  CatalogProviderMappingSelector,
  CatalogProviderMappingTransform,
  CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";

export type CatalogProviderMappingDiagnosticCode =
  | "missing-required-path"
  | "null-not-allowed"
  | "expected-array"
  | "empty-array"
  | "unregistered-named-selector"
  | "unregistered-named-transform"
  | "transform-type-mismatch"
  | "coerce-failed"
  | "lookup-miss";

export type CatalogProviderMappingInterpreterDiagnostic = Readonly<{
  code: CatalogProviderMappingDiagnosticCode;
  path: string;
  redaction: CatalogProviderMappingValueExpression["redaction"];
  diagnosticText: string;
}>;

export type CatalogProviderMappingEvidence = Readonly<{
  value: JsonValue;
  owner: CatalogProviderMappingValueExpression["owner"];
  uses: CatalogProviderMappingValueExpression["uses"];
  redaction: CatalogProviderMappingValueExpression["redaction"];
}>;

export type CatalogProviderMappingInterpreterResult = Readonly<{
  evidence: CatalogProviderMappingEvidence | null;
  omitted: boolean;
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
}>;

export type CatalogProviderNamedSelector = (input: {
  payload: JsonValue;
  rootPayload: JsonValue;
  path: string;
}) => JsonValue | null;

export type CatalogProviderNamedTransform = (input: { value: JsonValue; path: string }) => JsonValue | null;

export type CatalogProviderMappingInterpreterOptions = Readonly<{
  namedSelectors?: Readonly<Partial<Record<CatalogProviderMappingRuntimeFunctionKey, CatalogProviderNamedSelector>>>;
  namedTransforms?: Readonly<Partial<Record<CatalogProviderMappingRuntimeFunctionKey, CatalogProviderNamedTransform>>>;
  lookupTables?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
}>;

type SelectorEvaluationResult = Readonly<{
  value: JsonValue | null;
  omitted: boolean;
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
}>;

type SelectorEvaluationContext = Readonly<{
  payload: JsonValue;
  rootPayload: JsonValue;
  expression: CatalogProviderMappingValueExpression;
  options: CatalogProviderMappingInterpreterOptions;
  path: string;
  suppressRequiredDiagnostics?: boolean;
}>;

type PathResolutionResult = Readonly<{
  found: boolean;
  value: JsonValue | null;
}>;

export function evaluateCatalogProviderMappingExpression(
  expression: CatalogProviderMappingValueExpression,
  payload: JsonValue,
  options: CatalogProviderMappingInterpreterOptions = {},
  path = "expression",
): CatalogProviderMappingInterpreterResult {
  const selectorResult = evaluateSelector(expression.selector, {
    payload,
    rootPayload: payload,
    expression,
    options,
    path: `${path}.selector`,
  });
  const diagnostics = [...selectorResult.diagnostics];

  if (selectorResult.omitted) {
    return {
      evidence: null,
      omitted: true,
      diagnostics,
    };
  }

  let value = selectorResult.value;
  for (const [index, transform] of (expression.transforms ?? []).entries()) {
    const transformResult = applyTransform(transform, value, {
      expression,
      options,
      path: `${path}.transforms.${index}`,
    });
    diagnostics.push(...transformResult.diagnostics);
    if (transformResult.omitted) {
      return {
        evidence: null,
        omitted: true,
        diagnostics,
      };
    }
    value = transformResult.value;
  }

  return {
    evidence: {
      value,
      owner: expression.owner,
      uses: expression.uses,
      redaction: expression.redaction,
    },
    omitted: false,
    diagnostics,
  };
}

export function validateCatalogProviderMappingExpressionsAgainstFixtures(
  expressions: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
  fixtures: readonly JsonValue[],
  options: CatalogProviderMappingInterpreterOptions = {},
): readonly CatalogProviderMappingInterpreterDiagnostic[] {
  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];

  fixtures.forEach((fixture, fixtureIndex) => {
    for (const [expressionKey, expression] of Object.entries(expressions)) {
      diagnostics.push(
        ...evaluateCatalogProviderMappingExpression(
          expression,
          fixture,
          options,
          `fixtures.${fixtureIndex}.${expressionKey}`,
        ).diagnostics,
      );
    }
  });

  return diagnostics;
}

function evaluateSelector(
  selector: CatalogProviderMappingSelector,
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  switch (selector.kind) {
    case "path":
      return evaluatePathSelector(selector.path, selector.required, selector.nullPolicy, context);
    case "constant":
      return { value: selector.value, omitted: false, diagnostics: [] };
    case "coalesce":
      return evaluateCoalesceSelector(selector.selectors, selector.required, context);
    case "template":
      return evaluateTemplateSelector(selector.template, selector.values, selector.required, context);
    case "array":
      return evaluateArraySelector(selector.items, context);
    case "object":
      return evaluateObjectSelector(selector.fields, context);
    case "array-map":
      return evaluateArrayMapSelector(selector.path, selector.item, selector.emptyPolicy, context);
    case "named-runtime-selector":
      return evaluateNamedSelector(selector.functionKey, context);
  }
}

function evaluatePathSelector(
  selectorPath: string,
  required: boolean,
  nullPolicy: "allow-null" | "omit" | "diagnostic",
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const resolved = resolvePath(context.payload, selectorPath);
  if (!resolved.found) {
    return missingOrNullResult({
      code: "missing-required-path",
      path: `${context.path}.path`,
      required,
      nullPolicy,
      context,
      diagnosticText: `Required provider field '${selectorPath}' was not present.`,
    });
  }

  if (resolved.value === null) {
    return missingOrNullResult({
      code: "null-not-allowed",
      path: `${context.path}.nullPolicy`,
      required,
      nullPolicy,
      context,
      diagnosticText: `Provider field '${selectorPath}' resolved to null.`,
    });
  }

  return { value: resolved.value, omitted: false, diagnostics: [] };
}

function missingOrNullResult(input: {
  code: "missing-required-path" | "null-not-allowed";
  path: string;
  required: boolean;
  nullPolicy: "allow-null" | "omit" | "diagnostic";
  context: SelectorEvaluationContext;
  diagnosticText: string;
}): SelectorEvaluationResult {
  if (input.nullPolicy === "allow-null" && input.code === "null-not-allowed") {
    return { value: null, omitted: false, diagnostics: [] };
  }

  if (!input.required && input.nullPolicy === "omit") {
    return { value: null, omitted: true, diagnostics: [] };
  }

  if (input.context.suppressRequiredDiagnostics && input.code === "missing-required-path") {
    return { value: null, omitted: true, diagnostics: [] };
  }

  return {
    value: null,
    omitted: true,
    diagnostics: [
      {
        code: input.code,
        path: input.path,
        redaction: input.context.expression.redaction,
        diagnosticText: input.diagnosticText,
      },
    ],
  };
}

function evaluateCoalesceSelector(
  selectors: readonly CatalogProviderMappingSelector[],
  required: boolean,
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];

  for (const [index, selector] of selectors.entries()) {
    const result = evaluateSelector(selector, {
      ...context,
      path: `${context.path}.selectors.${index}`,
      suppressRequiredDiagnostics: true,
    });
    if (!result.omitted && result.value !== null) {
      return {
        value: result.value,
        omitted: false,
        diagnostics,
      };
    }
    diagnostics.push(...result.diagnostics);
  }

  if (!required) {
    return { value: null, omitted: true, diagnostics };
  }

  return {
    value: null,
    omitted: true,
    diagnostics: [
      ...diagnostics,
      {
        code: "missing-required-path",
        path: context.path,
        redaction: context.expression.redaction,
        diagnosticText: "Required coalesce selector did not resolve any provider field.",
      },
    ],
  };
}

function evaluateArraySelector(
  items: readonly CatalogProviderMappingValueExpression[],
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];
  const values: JsonValue[] = [];

  items.forEach((expression, index) => {
    const result = evaluateCatalogProviderMappingExpression(
      expression,
      context.payload,
      context.options,
      `${context.path}.items.${index}`,
    );
    diagnostics.push(...result.diagnostics);
    if (result.evidence) {
      values.push(result.evidence.value);
    }
  });

  return { value: values, omitted: false, diagnostics };
}

function evaluateTemplateSelector(
  template: string,
  values: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
  required: boolean,
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];
  const resolvedValues: Record<string, string> = {};

  for (const [valueKey, expression] of Object.entries(values)) {
    const result = evaluateCatalogProviderMappingExpression(
      expression,
      context.payload,
      context.options,
      `${context.path}.values.${valueKey}`,
    );
    diagnostics.push(...result.diagnostics);

    if (!result.evidence) {
      continue;
    }

    const value = result.evidence.value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      resolvedValues[valueKey] = String(value);
      continue;
    }

    diagnostics.push({
      code: "transform-type-mismatch",
      path: `${context.path}.values.${valueKey}`,
      redaction: expression.redaction,
      diagnosticText: "Template selector values must resolve to string-compatible provider evidence.",
    });
  }

  const missingKeys = [...template.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1])
    .filter((key) => !(key in resolvedValues));

  if (missingKeys.length > 0) {
    return required
      ? {
          value: null,
          omitted: true,
          diagnostics: [
            ...diagnostics,
            {
              code: "missing-required-path",
              path: context.path,
              redaction: context.expression.redaction,
              diagnosticText: `Template selector could not resolve value(s): ${missingKeys.join(", ")}.`,
            },
          ],
        }
      : { value: null, omitted: true, diagnostics };
  }

  return {
    value: Object.entries(resolvedValues).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template),
    omitted: false,
    diagnostics,
  };
}

function evaluateObjectSelector(
  fields: Readonly<Record<string, CatalogProviderMappingValueExpression>>,
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];
  const value: Record<string, JsonValue> = {};

  for (const [fieldKey, expression] of Object.entries(fields)) {
    const result = evaluateCatalogProviderMappingExpression(
      expression,
      context.payload,
      context.options,
      `${context.path}.fields.${fieldKey}`,
    );
    diagnostics.push(...result.diagnostics);
    if (result.evidence) {
      value[fieldKey] = result.evidence.value;
    }
  }

  return { value, omitted: false, diagnostics };
}

function evaluateArrayMapSelector(
  selectorPath: string,
  item: CatalogProviderMappingValueExpression,
  emptyPolicy: "allow-empty" | "diagnostic",
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const resolved = resolvePath(context.payload, selectorPath);
  if (!resolved.found || resolved.value === null) {
    return {
      value: [],
      omitted: true,
      diagnostics: [
        {
          code: "missing-required-path",
          path: `${context.path}.path`,
          redaction: context.expression.redaction,
          diagnosticText: `Provider array '${selectorPath}' was not present.`,
        },
      ],
    };
  }
  if (!Array.isArray(resolved.value)) {
    return {
      value: [],
      omitted: true,
      diagnostics: [
        {
          code: "expected-array",
          path: `${context.path}.path`,
          redaction: context.expression.redaction,
          diagnosticText: `Provider field '${selectorPath}' must be an array for array-map selectors.`,
        },
      ],
    };
  }
  if (resolved.value.length === 0 && emptyPolicy === "diagnostic") {
    return {
      value: [],
      omitted: false,
      diagnostics: [
        {
          code: "empty-array",
          path: `${context.path}.emptyPolicy`,
          redaction: context.expression.redaction,
          diagnosticText: `Provider array '${selectorPath}' was empty.`,
        },
      ],
    };
  }

  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];
  const values: JsonValue[] = [];
  resolved.value.forEach((entry, index) => {
    const result = evaluateCatalogProviderMappingExpression(
      item,
      entry,
      context.options,
      `${context.path}.item.${index}`,
    );
    diagnostics.push(...result.diagnostics);
    if (result.evidence) {
      values.push(result.evidence.value);
    }
  });

  return { value: values, omitted: false, diagnostics };
}

function evaluateNamedSelector(
  functionKey: CatalogProviderMappingRuntimeFunctionKey,
  context: SelectorEvaluationContext,
): SelectorEvaluationResult {
  const selector = context.options.namedSelectors?.[functionKey];
  if (!selector) {
    return {
      value: null,
      omitted: true,
      diagnostics: [
        {
          code: "unregistered-named-selector",
          path: `${context.path}.functionKey`,
          redaction: context.expression.redaction,
          diagnosticText: `Named selector '${functionKey}' is not registered for this interpreter run.`,
        },
      ],
    };
  }

  return {
    value: selector({
      payload: context.payload,
      rootPayload: context.rootPayload,
      path: context.path,
    }),
    omitted: false,
    diagnostics: [],
  };
}

function applyTransform(
  transform: CatalogProviderMappingTransform,
  value: JsonValue | null,
  context: Readonly<{
    expression: CatalogProviderMappingValueExpression;
    options: CatalogProviderMappingInterpreterOptions;
    path: string;
  }>,
): SelectorEvaluationResult {
  switch (transform.kind) {
    case "coerce":
      return coerceValue(value, transform.to, context);
    case "string":
      return applyStringTransform(value, transform.operation, context);
    case "lookup":
      return applyLookupTransform(value, transform.tableKey, transform.unknownPolicy, context);
    case "named-transform":
      return applyNamedTransform(value, transform.functionKey, context);
  }
}

function coerceValue(
  value: JsonValue | null,
  to: "string" | "number" | "boolean" | "json-object" | "json-array",
  context: Readonly<{ expression: CatalogProviderMappingValueExpression; path: string }>,
): SelectorEvaluationResult {
  if (to === "json-object") {
    return isJsonRecord(value)
      ? { value, omitted: false, diagnostics: [] }
      : transformDiagnostic("coerce-failed", context, "Provider evidence could not be coerced to a JSON object.");
  }

  if (to === "json-array") {
    return Array.isArray(value)
      ? { value, omitted: false, diagnostics: [] }
      : transformDiagnostic("coerce-failed", context, "Provider evidence could not be coerced to a JSON array.");
  }

  if (to === "string") {
    if (typeof value === "string") {
      return { value, omitted: false, diagnostics: [] };
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return { value: String(value), omitted: false, diagnostics: [] };
    }
  }

  if (to === "number") {
    const coerced = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
    return Number.isFinite(coerced)
      ? { value: coerced, omitted: false, diagnostics: [] }
      : transformDiagnostic("coerce-failed", context, "Provider evidence could not be coerced to a number.");
  }

  if (to === "boolean") {
    if (typeof value === "boolean") {
      return { value, omitted: false, diagnostics: [] };
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(normalized)) {
        return { value: true, omitted: false, diagnostics: [] };
      }
      if (["false", "no", "0"].includes(normalized)) {
        return { value: false, omitted: false, diagnostics: [] };
      }
    }
  }

  return transformDiagnostic("coerce-failed", context, `Provider evidence could not be coerced to ${to}.`);
}

function applyStringTransform(
  value: JsonValue | null,
  operation: "trim" | "lowercase" | "uppercase" | "slug" | "normalize-provider-option",
  context: Readonly<{ expression: CatalogProviderMappingValueExpression; path: string }>,
): SelectorEvaluationResult {
  if (typeof value !== "string") {
    return transformDiagnostic(
      "transform-type-mismatch",
      context,
      "String transforms require string provider evidence.",
    );
  }

  if (operation === "trim") {
    return { value: value.trim(), omitted: false, diagnostics: [] };
  }
  if (operation === "lowercase") {
    return { value: value.toLowerCase(), omitted: false, diagnostics: [] };
  }
  if (operation === "uppercase") {
    return { value: value.toUpperCase(), omitted: false, diagnostics: [] };
  }

  return {
    value: value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, ""),
    omitted: false,
    diagnostics: [],
  };
}

function applyLookupTransform(
  value: JsonValue | null,
  tableKey: string,
  unknownPolicy: "diagnostic" | "review-evidence" | "omit",
  context: Readonly<{
    expression: CatalogProviderMappingValueExpression;
    options: CatalogProviderMappingInterpreterOptions;
    path: string;
  }>,
): SelectorEvaluationResult {
  const lookupKey =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  const mapped = lookupKey ? context.options.lookupTables?.[tableKey]?.[lookupKey] : undefined;

  if (mapped !== undefined) {
    return { value: mapped, omitted: false, diagnostics: [] };
  }

  if (unknownPolicy === "omit") {
    return { value: null, omitted: true, diagnostics: [] };
  }

  const diagnostic = {
    code: "lookup-miss" as const,
    path: `${context.path}.tableKey`,
    redaction: context.expression.redaction,
    diagnosticText: `Provider evidence did not match lookup table '${tableKey}'.`,
  };

  return unknownPolicy === "review-evidence"
    ? { value, omitted: false, diagnostics: [diagnostic] }
    : { value: null, omitted: true, diagnostics: [diagnostic] };
}

function applyNamedTransform(
  value: JsonValue | null,
  functionKey: CatalogProviderMappingRuntimeFunctionKey,
  context: Readonly<{
    expression: CatalogProviderMappingValueExpression;
    options: CatalogProviderMappingInterpreterOptions;
    path: string;
  }>,
): SelectorEvaluationResult {
  const transform = context.options.namedTransforms?.[functionKey];
  if (!transform) {
    return {
      value: null,
      omitted: true,
      diagnostics: [
        {
          code: "unregistered-named-transform",
          path: `${context.path}.functionKey`,
          redaction: context.expression.redaction,
          diagnosticText: `Named transform '${functionKey}' is not registered for this interpreter run.`,
        },
      ],
    };
  }

  return {
    value: transform({ value, path: context.path }),
    omitted: false,
    diagnostics: [],
  };
}

function transformDiagnostic(
  code: Extract<CatalogProviderMappingDiagnosticCode, "transform-type-mismatch" | "coerce-failed">,
  context: Readonly<{ expression: CatalogProviderMappingValueExpression; path: string }>,
  diagnosticText: string,
): SelectorEvaluationResult {
  return {
    value: null,
    omitted: true,
    diagnostics: [
      {
        code,
        path: context.path,
        redaction: context.expression.redaction,
        diagnosticText,
      },
    ],
  };
}

function resolvePath(payload: JsonValue, selectorPath: string): PathResolutionResult {
  const segments = parsePathSegments(selectorPath);
  let current: JsonValue | null = payload;

  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
        return { found: false, value: null };
      }
      current = current[segment] ?? null;
      continue;
    }

    if (!isJsonRecord(current) || !(segment in current)) {
      return { found: false, value: null };
    }
    current = current[segment] ?? null;
  }

  return { found: true, value: current };
}

function parsePathSegments(selectorPath: string): readonly (string | number)[] {
  return selectorPath
    .split(".")
    .flatMap((part) => {
      const segments: (string | number)[] = [];
      const base = part.replace(/\[(\d+)\]/g, (_match, index: string) => {
        segments.push(Number(index));
        return "";
      });
      return base.length > 0 ? [base, ...segments] : segments;
    })
    .filter((segment) => segment !== "");
}

function isJsonRecord(value: JsonValue | null): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

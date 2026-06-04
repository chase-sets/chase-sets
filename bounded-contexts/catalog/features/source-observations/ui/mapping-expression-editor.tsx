import type { JsonValue } from "@chase-sets/primitives/json";
import { Button, Inline, Select, Stack, TextInput, Textarea, type SelectItem } from "@chase-sets/design-system";

export type MappingExpressionSelector =
  | { kind: "path"; path: string; required: boolean; nullPolicy: "allow-null" | "omit" | "diagnostic" }
  | { kind: "constant"; value: JsonValue }
  | { kind: "coalesce"; selectors: readonly MappingExpressionSelector[]; required: boolean }
  | { kind: "template"; template: string; values: Readonly<Record<string, MappingExpressionValue>>; required: boolean }
  | { kind: "array"; items: readonly MappingExpressionValue[] }
  | { kind: "object"; fields: Readonly<Record<string, MappingExpressionValue>> }
  | { kind: "array-map"; path: string; item: MappingExpressionValue; emptyPolicy: "allow-empty" | "diagnostic" }
  | { kind: "named-runtime-selector"; functionKey: string; reason: string };

export type MappingExpressionTransform =
  | { kind: "named-transform"; functionKey: string; reason: string }
  | { kind: "coerce"; to: "string" | "number" | "boolean" | "json-object" | "json-array" }
  | { kind: "string"; operation: "trim" | "lowercase" | "uppercase" | "slug" | "normalize-provider-option" }
  | { kind: "lookup"; tableKey: string; unknownPolicy: "diagnostic" | "review-evidence" | "omit" };

export type MappingExpressionValue = Readonly<{
  selector: MappingExpressionSelector;
  transforms?: readonly MappingExpressionTransform[];
  owner:
    | "catalog-truth"
    | "catalog-merge-evidence"
    | "external-reference"
    | "pricing-signal"
    | "inventory-signal"
    | "operations"
    | "excluded";
  uses: readonly (
    | "source-payload"
    | "normalized-observation"
    | "hash-material"
    | "merge-identity"
    | "external-reference"
    | "selected-option"
    | "reference-hierarchy"
    | "promotion-command"
  )[];
  redaction: "none" | "secret" | "seller" | "price" | "operations";
}>;

export interface MappingExpressionEditorProps {
  label: string;
  value: MappingExpressionValue;
  onChange: (value: MappingExpressionValue) => void;
  previewPayload?: JsonValue | null;
}

const SELECTOR_KIND_OPTIONS = [
  { value: "path", label: "Path" },
  { value: "constant", label: "Constant" },
  { value: "coalesce", label: "Coalesce" },
  { value: "template", label: "Template" },
  { value: "array", label: "Array" },
  { value: "object", label: "Object" },
  { value: "array-map", label: "Array map" },
  { value: "named-runtime-selector", label: "Named runtime selector" },
] satisfies SelectItem[];

const TRANSFORM_KIND_OPTIONS = [
  { value: "named-transform", label: "Named transform" },
  { value: "coerce", label: "Coerce" },
  { value: "string", label: "String transform" },
  { value: "lookup", label: "Lookup" },
] satisfies SelectItem[];

const OWNER_OPTIONS = [
  { value: "catalog-truth", label: "Catalog truth" },
  { value: "catalog-merge-evidence", label: "Catalog merge evidence" },
  { value: "external-reference", label: "External reference" },
  { value: "pricing-signal", label: "Pricing signal" },
  { value: "inventory-signal", label: "Inventory signal" },
  { value: "operations", label: "Operations" },
  { value: "excluded", label: "Excluded" },
] satisfies SelectItem[];

const USE_OPTIONS = [
  "source-payload",
  "normalized-observation",
  "hash-material",
  "merge-identity",
  "external-reference",
  "selected-option",
  "reference-hierarchy",
  "promotion-command",
] as const;

const REDACTION_OPTIONS = [
  { value: "none", label: "None" },
  { value: "secret", label: "Secret" },
  { value: "seller", label: "Seller" },
  { value: "price", label: "Price" },
  { value: "operations", label: "Operations" },
] satisfies SelectItem[];

const NULL_POLICY_OPTIONS = [
  { value: "allow-null", label: "Allow null" },
  { value: "omit", label: "Omit" },
  { value: "diagnostic", label: "Diagnostic" },
] satisfies SelectItem[];

const COERCE_OPTIONS = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "json-object", label: "JSON object" },
  { value: "json-array", label: "JSON array" },
] satisfies SelectItem[];

const STRING_TRANSFORM_OPTIONS = [
  { value: "trim", label: "Trim" },
  { value: "lowercase", label: "Lowercase" },
  { value: "uppercase", label: "Uppercase" },
  { value: "slug", label: "Slug" },
  { value: "normalize-provider-option", label: "Normalize provider option" },
] satisfies SelectItem[];

const UNKNOWN_POLICY_OPTIONS = [
  { value: "diagnostic", label: "Diagnostic" },
  { value: "review-evidence", label: "Review evidence" },
  { value: "omit", label: "Omit" },
] satisfies SelectItem[];

const RUNTIME_FUNCTION_OPTIONS = [
  { value: "tcgdex-card-variant-expander", label: "TCGdex card variant expander" },
  { value: "tcgdex-marketplace-reference-extractor", label: "TCGdex marketplace reference extractor" },
  { value: "tcgdex-pokemon-reference-hierarchy", label: "TCGdex Pokemon reference hierarchy" },
  { value: "tcgdex-pokemon-promotion-command-plan", label: "TCGdex Pokemon promotion command plan" },
  { value: "tcgplayer-product-barcode", label: "TCGplayer product barcode" },
  { value: "tcgplayer-product-form", label: "TCGplayer product form" },
  { value: "tcgplayer-sku-selected-option-resolver", label: "TCGplayer SKU selected option resolver" },
  { value: "scrydex-tcgplayer-id-reference-extractor", label: "Scrydex TCGplayer ID reference extractor" },
] satisfies SelectItem[];

export function MappingExpressionEditor({
  label,
  value,
  onChange,
  previewPayload,
}: Readonly<MappingExpressionEditorProps>) {
  const diagnostics = validateMappingExpression(value);
  const preview = previewPayload ? previewMappingExpression(value, previewPayload) : null;
  const setExpression = (patch: Partial<MappingExpressionValue>) => onChange({ ...value, ...patch });

  return (
    <Stack gap={3}>
      <h3 className="text-sm font-semibold text-foreground">{label}</h3>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <SelectorEditor selector={value.selector} onChange={(selector) => setExpression({ selector })} path={label} />
      <Inline gap={3}>
        <Select
          label="Evidence owner"
          value={value.owner}
          items={OWNER_OPTIONS}
          onValueChange={(owner) => setExpression({ owner: owner as MappingExpressionValue["owner"] })}
        />
        <Select
          label="Redaction"
          value={value.redaction}
          items={REDACTION_OPTIONS}
          onValueChange={(redaction) => setExpression({ redaction: redaction as MappingExpressionValue["redaction"] })}
        />
      </Inline>
      <CheckboxSet
        legend="Evidence uses"
        options={USE_OPTIONS}
        selected={value.uses}
        onChange={(uses) => setExpression({ uses: uses as MappingExpressionValue["uses"] })}
      />
      <TransformList
        transforms={value.transforms ?? []}
        onChange={(transforms) => setExpression({ transforms: transforms.length > 0 ? transforms : undefined })}
      />
      {preview ? (
        <Stack gap={1}>
          <h4 className="text-sm font-semibold text-foreground">Fixture Preview</h4>
          <p className="text-sm text-foreground">{summarizePreviewValue(preview.value)}</p>
          {preview.diagnostics.length > 0 ? (
            <ul className="text-sm text-danger">
              {preview.diagnostics.map((diagnostic) => (
                <li key={diagnostic}>{diagnostic}</li>
              ))}
            </ul>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

function SelectorEditor({
  selector,
  onChange,
  path,
}: Readonly<{
  selector: MappingExpressionSelector;
  onChange: (selector: MappingExpressionSelector) => void;
  path: string;
}>) {
  return (
    <Stack gap={3}>
      <Select
        label="Selector kind"
        value={selector.kind}
        items={SELECTOR_KIND_OPTIONS}
        onValueChange={(kind) => onChange(defaultSelector(kind))}
      />
      {selector.kind === "path" ? <PathSelectorEditor selector={selector} onChange={onChange} /> : null}
      {selector.kind === "constant" ? <ConstantSelectorEditor selector={selector} onChange={onChange} /> : null}
      {selector.kind === "coalesce" ? (
        <CoalesceSelectorEditor selector={selector} onChange={onChange} path={path} />
      ) : null}
      {selector.kind === "template" ? (
        <TemplateSelectorEditor selector={selector} onChange={onChange} path={path} />
      ) : null}
      {selector.kind === "array" ? <ArraySelectorEditor selector={selector} onChange={onChange} path={path} /> : null}
      {selector.kind === "object" ? <ObjectSelectorEditor selector={selector} onChange={onChange} path={path} /> : null}
      {selector.kind === "array-map" ? (
        <ArrayMapSelectorEditor selector={selector} onChange={onChange} path={path} />
      ) : null}
      {selector.kind === "named-runtime-selector" ? (
        <NamedRuntimeSelectorEditor selector={selector} onChange={onChange} />
      ) : null}
    </Stack>
  );
}

function PathSelectorEditor({
  selector,
  onChange,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "path" }>;
  onChange: (selector: MappingExpressionSelector) => void;
}>) {
  return (
    <Inline gap={3}>
      <TextInput
        label="Path"
        value={selector.path}
        onChange={(event) => onChange({ ...selector, path: event.currentTarget.value })}
      />
      <Select
        label="Null policy"
        value={selector.nullPolicy}
        items={NULL_POLICY_OPTIONS}
        onValueChange={(nullPolicy) =>
          onChange({
            ...selector,
            nullPolicy: nullPolicy as Extract<MappingExpressionSelector, { kind: "path" }>["nullPolicy"],
          })
        }
      />
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={selector.required}
          onChange={() => onChange({ ...selector, required: !selector.required })}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        <span>Required path</span>
      </label>
    </Inline>
  );
}

function ConstantSelectorEditor({
  selector,
  onChange,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "constant" }>;
  onChange: (selector: MappingExpressionSelector) => void;
}>) {
  return (
    <Textarea
      label="Constant JSON"
      value={JSON.stringify(selector.value, null, 2)}
      rows={3}
      onChange={(event) => onChange({ ...selector, value: parseJsonInput(event.currentTarget.value) })}
    />
  );
}

function CoalesceSelectorEditor({
  selector,
  onChange,
  path,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "coalesce" }>;
  onChange: (selector: MappingExpressionSelector) => void;
  path: string;
}>) {
  return (
    <Stack gap={3}>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={selector.required}
          onChange={() => onChange({ ...selector, required: !selector.required })}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        <span>Required coalesce result</span>
      </label>
      <SelectorList
        label="Fallback selectors"
        selectors={selector.selectors}
        onChange={(selectors) => onChange({ ...selector, selectors })}
        path={path}
      />
    </Stack>
  );
}

function TemplateSelectorEditor({
  selector,
  onChange,
  path,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "template" }>;
  onChange: (selector: MappingExpressionSelector) => void;
  path: string;
}>) {
  return (
    <Stack gap={3}>
      <Inline gap={3}>
        <TextInput
          label="Template"
          value={selector.template}
          onChange={(event) => onChange({ ...selector, template: event.currentTarget.value })}
        />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={selector.required}
            onChange={() => onChange({ ...selector, required: !selector.required })}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          <span>Required template result</span>
        </label>
      </Inline>
      <ExpressionRecordEditor
        label="Template values"
        values={selector.values}
        defaultKey="value"
        onChange={(values) => onChange({ ...selector, values })}
        path={path}
      />
    </Stack>
  );
}

function ArraySelectorEditor({
  selector,
  onChange,
  path,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "array" }>;
  onChange: (selector: MappingExpressionSelector) => void;
  path: string;
}>) {
  return (
    <ExpressionList
      label="Array items"
      values={selector.items}
      onChange={(items) => onChange({ ...selector, items })}
      path={path}
    />
  );
}

function ObjectSelectorEditor({
  selector,
  onChange,
  path,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "object" }>;
  onChange: (selector: MappingExpressionSelector) => void;
  path: string;
}>) {
  return (
    <ExpressionRecordEditor
      label="Object fields"
      values={selector.fields}
      defaultKey="field"
      onChange={(fields) => onChange({ ...selector, fields })}
      path={path}
    />
  );
}

function ArrayMapSelectorEditor({
  selector,
  onChange,
  path,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "array-map" }>;
  onChange: (selector: MappingExpressionSelector) => void;
  path: string;
}>) {
  return (
    <Stack gap={3}>
      <Inline gap={3}>
        <TextInput
          label="Array path"
          value={selector.path}
          onChange={(event) => onChange({ ...selector, path: event.currentTarget.value })}
        />
        <Select
          label="Empty policy"
          value={selector.emptyPolicy}
          items={[
            { value: "allow-empty", label: "Allow empty" },
            { value: "diagnostic", label: "Diagnostic" },
          ]}
          onValueChange={(emptyPolicy) =>
            onChange({
              ...selector,
              emptyPolicy: emptyPolicy as Extract<MappingExpressionSelector, { kind: "array-map" }>["emptyPolicy"],
            })
          }
        />
      </Inline>
      <MappingExpressionEditor
        label={`${path} item`}
        value={selector.item}
        onChange={(item) => onChange({ ...selector, item })}
      />
    </Stack>
  );
}

function NamedRuntimeSelectorEditor({
  selector,
  onChange,
}: Readonly<{
  selector: Extract<MappingExpressionSelector, { kind: "named-runtime-selector" }>;
  onChange: (selector: MappingExpressionSelector) => void;
}>) {
  return (
    <Inline gap={3}>
      <Select
        label="Runtime selector"
        value={selector.functionKey}
        items={RUNTIME_FUNCTION_OPTIONS}
        onValueChange={(functionKey) => onChange({ ...selector, functionKey })}
      />
      <TextInput
        label="Selector reason"
        value={selector.reason}
        onChange={(event) => onChange({ ...selector, reason: event.currentTarget.value })}
      />
    </Inline>
  );
}

function SelectorList({
  label,
  selectors,
  onChange,
  path,
}: Readonly<{
  label: string;
  selectors: readonly MappingExpressionSelector[];
  onChange: (selectors: readonly MappingExpressionSelector[]) => void;
  path: string;
}>) {
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <h4 className="text-sm font-semibold text-foreground">{label}</h4>
        <Button size="sm" tone="secondary" onClick={() => onChange([...selectors, defaultSelector("path")])}>
          Add selector
        </Button>
      </Inline>
      {selectors.map((selector, index) => (
        <Stack key={index} gap={2}>
          <Inline gap={2}>
            <span className="text-sm font-semibold text-secondary">Selector {index + 1}</span>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === 0}
              onClick={() => onChange(moveItem(selectors, index, index - 1))}
            >
              Up
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === selectors.length - 1}
              onClick={() => onChange(moveItem(selectors, index, index + 1))}
            >
              Down
            </Button>
            <Button size="sm" tone="secondary" onClick={() => onChange(insertItem(selectors, index + 1, selector))}>
              Duplicate
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(removeItem(selectors, index))}>
              Remove
            </Button>
          </Inline>
          <SelectorEditor
            selector={selector}
            onChange={(nextSelector) => onChange(replaceItem(selectors, index, nextSelector))}
            path={`${path}.${index}`}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function ExpressionList({
  label,
  values,
  onChange,
  path,
}: Readonly<{
  label: string;
  values: readonly MappingExpressionValue[];
  onChange: (values: readonly MappingExpressionValue[]) => void;
  path: string;
}>) {
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <h4 className="text-sm font-semibold text-foreground">{label}</h4>
        <Button size="sm" tone="secondary" onClick={() => onChange([...values, defaultExpression()])}>
          Add expression
        </Button>
      </Inline>
      {values.map((value, index) => (
        <Stack key={index} gap={2}>
          <Inline gap={2}>
            <span className="text-sm font-semibold text-secondary">Expression {index + 1}</span>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === 0}
              onClick={() => onChange(moveItem(values, index, index - 1))}
            >
              Up
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === values.length - 1}
              onClick={() => onChange(moveItem(values, index, index + 1))}
            >
              Down
            </Button>
            <Button size="sm" tone="secondary" onClick={() => onChange(insertItem(values, index + 1, value))}>
              Duplicate
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(removeItem(values, index))}>
              Remove
            </Button>
          </Inline>
          <MappingExpressionEditor
            label={`${path} expression ${index + 1}`}
            value={value}
            onChange={(nextValue) => onChange(replaceItem(values, index, nextValue))}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function ExpressionRecordEditor({
  label,
  values,
  defaultKey,
  onChange,
  path,
}: Readonly<{
  label: string;
  values: Readonly<Record<string, MappingExpressionValue>>;
  defaultKey: string;
  onChange: (values: Readonly<Record<string, MappingExpressionValue>>) => void;
  path: string;
}>) {
  const entries = Object.entries(values);
  const setEntryKey = (index: number, key: string) => {
    const nextEntries = entries.map((entry, entryIndex) => (entryIndex === index ? [key, entry[1]] : entry));
    onChange(Object.fromEntries(nextEntries));
  };
  const setEntryValue = (index: number, value: MappingExpressionValue) => {
    const nextEntries = entries.map((entry, entryIndex) => (entryIndex === index ? [entry[0], value] : entry));
    onChange(Object.fromEntries(nextEntries));
  };

  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <h4 className="text-sm font-semibold text-foreground">{label}</h4>
        <Button
          size="sm"
          tone="secondary"
          onClick={() => onChange({ ...values, [`${defaultKey}${entries.length + 1}`]: defaultExpression() })}
        >
          Add field
        </Button>
      </Inline>
      {entries.map(([key, value], index) => (
        <Stack key={`${key}-${index}`} gap={2}>
          <Inline gap={2}>
            <TextInput
              label="Field key"
              value={key}
              onChange={(event) => setEntryKey(index, event.currentTarget.value)}
            />
            <Button
              size="sm"
              tone="secondary"
              onClick={() => onChange(Object.fromEntries(insertItem(entries, index + 1, [`${key}Copy`, value])))}
            >
              Duplicate
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(Object.fromEntries(removeItem(entries, index)))}>
              Remove
            </Button>
          </Inline>
          <MappingExpressionEditor
            label={`${path}.${key}`}
            value={value}
            onChange={(nextValue) => setEntryValue(index, nextValue)}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function TransformList({
  transforms,
  onChange,
}: Readonly<{
  transforms: readonly MappingExpressionTransform[];
  onChange: (transforms: readonly MappingExpressionTransform[]) => void;
}>) {
  return (
    <Stack gap={2}>
      <Inline gap={2}>
        <h4 className="text-sm font-semibold text-foreground">Transforms</h4>
        <Button size="sm" tone="secondary" onClick={() => onChange([...transforms, defaultTransform("coerce")])}>
          Add transform
        </Button>
      </Inline>
      {transforms.map((transform, index) => (
        <Stack key={index} gap={2}>
          <Inline gap={2}>
            <span className="text-sm font-semibold text-secondary">Transform {index + 1}</span>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === 0}
              onClick={() => onChange(moveItem(transforms, index, index - 1))}
            >
              Up
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === transforms.length - 1}
              onClick={() => onChange(moveItem(transforms, index, index + 1))}
            >
              Down
            </Button>
            <Button size="sm" tone="secondary" onClick={() => onChange(insertItem(transforms, index + 1, transform))}>
              Duplicate
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(removeItem(transforms, index))}>
              Remove
            </Button>
          </Inline>
          <TransformEditor
            transform={transform}
            onChange={(nextTransform) => onChange(replaceItem(transforms, index, nextTransform))}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function TransformEditor({
  transform,
  onChange,
}: Readonly<{
  transform: MappingExpressionTransform;
  onChange: (transform: MappingExpressionTransform) => void;
}>) {
  return (
    <Inline gap={3}>
      <Select
        label="Transform kind"
        value={transform.kind}
        items={TRANSFORM_KIND_OPTIONS}
        onValueChange={(kind) => onChange(defaultTransform(kind))}
      />
      {transform.kind === "named-transform" ? (
        <>
          <Select
            label="Transform function"
            value={transform.functionKey}
            items={RUNTIME_FUNCTION_OPTIONS}
            onValueChange={(functionKey) => onChange({ ...transform, functionKey })}
          />
          <TextInput
            label="Transform reason"
            value={transform.reason}
            onChange={(event) => onChange({ ...transform, reason: event.currentTarget.value })}
          />
        </>
      ) : null}
      {transform.kind === "coerce" ? (
        <Select
          label="Coerce to"
          value={transform.to}
          items={COERCE_OPTIONS}
          onValueChange={(to) =>
            onChange({ ...transform, to: to as Extract<MappingExpressionTransform, { kind: "coerce" }>["to"] })
          }
        />
      ) : null}
      {transform.kind === "string" ? (
        <Select
          label="String operation"
          value={transform.operation}
          items={STRING_TRANSFORM_OPTIONS}
          onValueChange={(operation) =>
            onChange({
              ...transform,
              operation: operation as Extract<MappingExpressionTransform, { kind: "string" }>["operation"],
            })
          }
        />
      ) : null}
      {transform.kind === "lookup" ? (
        <>
          <TextInput
            label="Lookup table"
            value={transform.tableKey}
            onChange={(event) => onChange({ ...transform, tableKey: event.currentTarget.value })}
          />
          <Select
            label="Unknown policy"
            value={transform.unknownPolicy}
            items={UNKNOWN_POLICY_OPTIONS}
            onValueChange={(unknownPolicy) =>
              onChange({
                ...transform,
                unknownPolicy: unknownPolicy as Extract<
                  MappingExpressionTransform,
                  { kind: "lookup" }
                >["unknownPolicy"],
              })
            }
          />
        </>
      ) : null}
    </Inline>
  );
}

function CheckboxSet({
  legend,
  options,
  selected,
  onChange,
}: Readonly<{
  legend: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}>) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-foreground">{legend}</legend>
      <div className="grid gap-2 md:grid-cols-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() => onChange(toggleStringSelection(selected, option))}
              className="h-4 w-4 rounded border-border accent-accent"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function defaultExpression(): MappingExpressionValue {
  return {
    selector: defaultSelector("path"),
    owner: "operations",
    uses: ["source-payload"],
    redaction: "none",
  };
}

function defaultSelector(kind: string): MappingExpressionSelector {
  switch (kind) {
    case "constant":
      return { kind: "constant", value: "" };
    case "coalesce":
      return { kind: "coalesce", selectors: [defaultSelector("path")], required: false };
    case "template":
      return { kind: "template", template: "{value}", values: { value: defaultExpression() }, required: true };
    case "array":
      return { kind: "array", items: [defaultExpression()] };
    case "object":
      return { kind: "object", fields: { value: defaultExpression() } };
    case "array-map":
      return { kind: "array-map", path: "", item: defaultExpression(), emptyPolicy: "allow-empty" };
    case "named-runtime-selector":
      return { kind: "named-runtime-selector", functionKey: RUNTIME_FUNCTION_OPTIONS[0].value, reason: "" };
    default:
      return { kind: "path", path: "", required: true, nullPolicy: "diagnostic" };
  }
}

function defaultTransform(kind: string): MappingExpressionTransform {
  switch (kind) {
    case "named-transform":
      return { kind: "named-transform", functionKey: RUNTIME_FUNCTION_OPTIONS[0].value, reason: "" };
    case "string":
      return { kind: "string", operation: "trim" };
    case "lookup":
      return { kind: "lookup", tableKey: "", unknownPolicy: "diagnostic" };
    default:
      return { kind: "coerce", to: "string" };
  }
}

export function validateMappingExpression(expression: MappingExpressionValue): string[] {
  const diagnostics: string[] = [];
  validateSelector(expression.selector, "selector", diagnostics);
  for (const [index, transform] of (expression.transforms ?? []).entries()) {
    if (transform.kind === "named-transform" && (!transform.functionKey || !transform.reason.trim())) {
      diagnostics.push(`transforms.${index}: named transform requires a function and reason.`);
    }
    if (transform.kind === "lookup" && !transform.tableKey.trim()) {
      diagnostics.push(`transforms.${index}: lookup transform requires a table key.`);
    }
  }
  if (expression.uses.length === 0) {
    diagnostics.push("Evidence uses must include at least one use.");
  }
  return diagnostics;
}

function validateSelector(selector: MappingExpressionSelector, path: string, diagnostics: string[]): void {
  if (selector.kind === "path" && selector.required && !selector.path.trim()) {
    diagnostics.push(`${path}: required path is missing.`);
  }
  if (selector.kind === "coalesce" && selector.selectors.length === 0) {
    diagnostics.push(`${path}: coalesce requires at least one fallback selector.`);
  }
  if (selector.kind === "template") {
    const referenced = templateKeys(selector.template);
    for (const key of referenced) {
      if (!selector.values[key]) {
        diagnostics.push(`${path}: template value '${key}' is unresolved.`);
      }
    }
    for (const [key, value] of Object.entries(selector.values)) {
      validateSelector(value.selector, `${path}.values.${key}`, diagnostics);
    }
  }
  if (selector.kind === "array-map") {
    if (!selector.path.trim()) {
      diagnostics.push(`${path}: array map requires a source path.`);
    }
    validateSelector(selector.item.selector, `${path}.item`, diagnostics);
  }
}

function templateKeys(template: string): readonly string[] {
  return Array.from(template.matchAll(/\{([^}]+)\}/g), (match) => match[1]);
}

export function previewMappingExpression(expression: MappingExpressionValue, payload: JsonValue) {
  const diagnostics: string[] = [];
  let value = previewSelector(expression.selector, payload, payload, diagnostics);
  for (const transform of expression.transforms ?? []) {
    value = previewTransform(transform, value, diagnostics);
  }
  return { value, diagnostics };
}

function previewSelector(
  selector: MappingExpressionSelector,
  payload: JsonValue,
  item: JsonValue,
  diagnostics: string[],
): JsonValue {
  switch (selector.kind) {
    case "path": {
      const value = valueAtPath(item, selector.path) ?? valueAtPath(payload, selector.path);
      if (value === undefined && selector.required) {
        diagnostics.push(`Preview path '${selector.path}' was not found.`);
      }
      return value === undefined ? null : value;
    }
    case "constant":
      return selector.value;
    case "coalesce": {
      for (const candidate of selector.selectors) {
        const value = previewSelector(candidate, payload, item, diagnostics);
        if (value !== null && value !== undefined && value !== "") {
          return value;
        }
      }
      if (selector.required) {
        diagnostics.push("Preview coalesce did not find a value.");
      }
      return null;
    }
    case "template":
      return templateKeys(selector.template).reduce(
        (preview, key) =>
          preview.replace(
            `{${key}}`,
            summarizePreviewValue(previewMappingExpression(selector.values[key] ?? defaultExpression(), payload).value),
          ),
        selector.template,
      );
    case "array":
      return selector.items.map((entry) => previewMappingExpression(entry, payload).value);
    case "object":
      return Object.fromEntries(
        Object.entries(selector.fields).map(([key, entry]) => [key, previewMappingExpression(entry, payload).value]),
      ) as JsonValue;
    case "array-map": {
      const source = valueAtPath(payload, selector.path);
      if (!Array.isArray(source)) {
        if (selector.emptyPolicy === "diagnostic") {
          diagnostics.push(`Preview array path '${selector.path}' did not resolve to an array.`);
        }
        return [];
      }
      return source.map((entry) => previewSelector(selector.item.selector, payload, entry as JsonValue, diagnostics));
    }
    case "named-runtime-selector":
      diagnostics.push(`Preview for runtime selector '${selector.functionKey}' requires server dry-run context.`);
      return null;
  }
}

function previewTransform(transform: MappingExpressionTransform, value: JsonValue, diagnostics: string[]): JsonValue {
  if (transform.kind === "named-transform") {
    diagnostics.push(`Preview for transform '${transform.functionKey}' requires server dry-run context.`);
    return value;
  }
  if (transform.kind === "lookup") {
    diagnostics.push(`Preview for lookup table '${transform.tableKey || "unknown"}' requires Catalog option context.`);
    return value;
  }
  if (transform.kind === "coerce") {
    return coercePreviewValue(value, transform.to);
  }
  const text = value === null || value === undefined ? "" : String(value);
  switch (transform.operation) {
    case "trim":
      return text.trim();
    case "lowercase":
      return text.toLowerCase();
    case "uppercase":
      return text.toUpperCase();
    case "slug":
    case "normalize-provider-option":
      return text
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
  }
}

function coercePreviewValue(value: JsonValue, target: Extract<MappingExpressionTransform, { kind: "coerce" }>["to"]) {
  switch (target) {
    case "number": {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) ? numericValue : null;
    }
    case "boolean":
      return value === true || value === "true";
    case "json-object":
      return isRecord(value) ? value : null;
    case "json-array":
      return Array.isArray(value) ? value : [];
    default:
      return value === null || value === undefined ? "" : String(value);
  }
}

function valueAtPath(value: JsonValue, path: string): JsonValue | undefined {
  if (!path.trim()) {
    return value;
  }
  return path.split(".").reduce<JsonValue | undefined>((current, segment) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    return isRecord(current) ? current[segment] : undefined;
  }, value);
}

function summarizePreviewValue(value: JsonValue): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonInput(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function toggleStringSelection(selected: readonly string[], option: string): readonly string[] {
  return selected.includes(option) ? selected.filter((entry) => entry !== option) : [...selected, option];
}

function replaceItem<T>(items: readonly T[], index: number, value: T): readonly T[] {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function insertItem<T>(items: readonly T[], index: number, value: T): readonly T[] {
  const nextItems = [...items];
  nextItems.splice(index, 0, value);
  return nextItems;
}

function removeItem<T>(items: readonly T[], index: number): readonly T[] {
  return items.filter((_, itemIndex) => itemIndex !== index);
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): readonly T[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

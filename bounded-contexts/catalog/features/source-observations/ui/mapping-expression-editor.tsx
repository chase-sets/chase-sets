import { t } from "@chase-sets/localization";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Heading,
  Inline,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  ValidationSummary,
  type SelectItem,
} from "@chase-sets/design-system";

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
  { value: "path", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.path") },
  { value: "constant", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.constant") },
  { value: "coalesce", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.coalesce") },
  { value: "template", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.template") },
  { value: "array", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.array") },
  { value: "object", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.object") },
  { value: "array-map", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.array.map") },
  {
    value: "named-runtime-selector",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.named.runtime.selector"),
  },
] satisfies SelectItem[];

const TRANSFORM_KIND_OPTIONS = [
  {
    value: "named-transform",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.named.transform"),
  },
  { value: "coerce", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.coerce") },
  { value: "string", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.string.transform") },
  { value: "lookup", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.lookup") },
] satisfies SelectItem[];

const OWNER_OPTIONS = [
  { value: "catalog-truth", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.catalog.truth") },
  {
    value: "catalog-merge-evidence",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.catalog.merge.evidence"),
  },
  {
    value: "external-reference",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.external.reference"),
  },
  {
    value: "pricing-signal",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.pricing.signal"),
  },
  {
    value: "inventory-signal",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.inventory.signal"),
  },
  { value: "operations", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.operations") },
  { value: "excluded", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.excluded") },
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
  { value: "none", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.none") },
  { value: "secret", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.secret") },
  { value: "seller", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.seller") },
  { value: "price", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.price") },
  { value: "operations", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.operations") },
] satisfies SelectItem[];

const NULL_POLICY_OPTIONS = [
  { value: "allow-null", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.allow.null") },
  { value: "omit", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.omit") },
  { value: "diagnostic", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.diagnostic") },
] satisfies SelectItem[];

const COERCE_OPTIONS = [
  { value: "string", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.string") },
  { value: "number", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.number") },
  { value: "boolean", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.boolean") },
  { value: "json-object", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.json.object") },
  { value: "json-array", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.json.array") },
] satisfies SelectItem[];

const STRING_TRANSFORM_OPTIONS = [
  { value: "trim", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.trim") },
  { value: "lowercase", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.lowercase") },
  { value: "uppercase", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.uppercase") },
  { value: "slug", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.slug") },
  {
    value: "normalize-provider-option",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.normalize.provider.option"),
  },
] satisfies SelectItem[];

const UNKNOWN_POLICY_OPTIONS = [
  { value: "diagnostic", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.diagnostic") },
  {
    value: "review-evidence",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.review.evidence"),
  },
  { value: "omit", label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.omit") },
] satisfies SelectItem[];

const RUNTIME_FUNCTION_OPTIONS = [
  {
    value: "tcgdex-card-variant-expander",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.card.variant.expander"),
  },
  {
    value: "tcgdex-marketplace-reference-extractor",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.marketplace.reference.extractor"),
  },
  {
    value: "tcgdex-pokemon-reference-hierarchy",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.pokemon.reference.hierarchy"),
  },
  {
    value: "tcgdex-pokemon-promotion-command-plan",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgdex.pokemon.promotion.command.plan"),
  },
  {
    value: "tcgplayer-product-barcode",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgplayer.product.barcode"),
  },
  {
    value: "tcgplayer-product-form",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgplayer.product.form"),
  },
  {
    value: "tcgplayer-sku-selected-option-resolver",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.tcgplayer.sku.selected.option.resolver"),
  },
  {
    value: "scrydex-tcgplayer-id-reference-extractor",
    label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.scrydex.tcgplayer.id.reference.extractor"),
  },
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
      <Heading level={6}>{label}</Heading>
      {diagnostics.length > 0 ? (
        <ValidationSummary title={label} errors={diagnostics.map((message) => ({ message }))} />
      ) : null}
      <SelectorEditor selector={value.selector} onChange={(selector) => setExpression({ selector })} path={label} />
      <Inline gap={3}>
        <Select
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.evidence.owner")}
          value={value.owner}
          items={OWNER_OPTIONS}
          onValueChange={(owner) => setExpression({ owner: owner as MappingExpressionValue["owner"] })}
        />
        <Select
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.redaction")}
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
          <Heading level={6}>
            {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.fixture.preview")}
          </Heading>
          <Text size="sm">{summarizePreviewValue(preview.value)}</Text>
          {preview.diagnostics.length > 0 ? (
            <ValidationSummary
              title={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.fixture.preview")}
              errors={preview.diagnostics.map((message) => ({ message }))}
            />
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
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.selector.kind")}
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
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.path")}
        value={selector.path}
        onChange={(event) => onChange({ ...selector, path: event.currentTarget.value })}
      />
      <Select
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.null.policy")}
        value={selector.nullPolicy}
        items={NULL_POLICY_OPTIONS}
        onValueChange={(nullPolicy) =>
          onChange({
            ...selector,
            nullPolicy: nullPolicy as Extract<MappingExpressionSelector, { kind: "path" }>["nullPolicy"],
          })
        }
      />
      <Checkbox
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.required.path")}
        checked={selector.required}
        onCheckedChange={() => onChange({ ...selector, required: !selector.required })}
      />
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
      label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.constant.json")}
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
      <Checkbox
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.required.coalesce.result")}
        checked={selector.required}
        onCheckedChange={() => onChange({ ...selector, required: !selector.required })}
      />
      <SelectorList
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.fallback.selectors")}
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
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.template")}
          value={selector.template}
          onChange={(event) => onChange({ ...selector, template: event.currentTarget.value })}
        />
        <Checkbox
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.required.template.result")}
          checked={selector.required}
          onCheckedChange={() => onChange({ ...selector, required: !selector.required })}
        />
      </Inline>
      <ExpressionRecordEditor
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.template.values")}
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
      label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.array.items")}
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
      label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.object.fields")}
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
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.array.path")}
          value={selector.path}
          onChange={(event) => onChange({ ...selector, path: event.currentTarget.value })}
        />
        <Select
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.empty.policy")}
          value={selector.emptyPolicy}
          items={[
            {
              value: "allow-empty",
              label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.allow.empty"),
            },
            {
              value: "diagnostic",
              label: t("catalog.features.sourceObservations.ui.mappingExpressionEditor.diagnostic"),
            },
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
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.value.item", { value: String(path) })}
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
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.runtime.selector")}
        value={selector.functionKey}
        items={RUNTIME_FUNCTION_OPTIONS}
        onValueChange={(functionKey) => onChange({ ...selector, functionKey })}
      />
      <TextInput
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.selector.reason")}
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
        <Heading level={6}>{label}</Heading>
        <Button size="sm" tone="secondary" onClick={() => onChange([...selectors, defaultSelector("path")])}>
          {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.add.selector")}
        </Button>
      </Inline>
      {selectors.map((selector, index) => (
        <Stack key={index} gap={2}>
          <Inline gap={2}>
            <Text element="span" size="sm" tone="secondary" weight="semibold">
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.selector")}
              {index + 1}
            </Text>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === 0}
              onClick={() => onChange(moveItem(selectors, index, index - 1))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.up")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === selectors.length - 1}
              onClick={() => onChange(moveItem(selectors, index, index + 1))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.down")}
            </Button>
            <Button size="sm" tone="secondary" onClick={() => onChange(insertItem(selectors, index + 1, selector))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.duplicate")}
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(removeItem(selectors, index))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.remove")}
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
        <Heading level={6}>{label}</Heading>
        <Button size="sm" tone="secondary" onClick={() => onChange([...values, defaultExpression()])}>
          {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.add.expression")}
        </Button>
      </Inline>
      {values.map((value, index) => (
        <Stack key={index} gap={2}>
          <Inline gap={2}>
            <Text element="span" size="sm" tone="secondary" weight="semibold">
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.expression")}
              {index + 1}
            </Text>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === 0}
              onClick={() => onChange(moveItem(values, index, index - 1))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.up")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === values.length - 1}
              onClick={() => onChange(moveItem(values, index, index + 1))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.down")}
            </Button>
            <Button size="sm" tone="secondary" onClick={() => onChange(insertItem(values, index + 1, value))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.duplicate")}
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(removeItem(values, index))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.remove")}
            </Button>
          </Inline>
          <MappingExpressionEditor
            label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.value.expression.value", {
              value0: String(path),
              value1: String(index + 1),
            })}
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
        <Heading level={6}>{label}</Heading>
        <Button
          size="sm"
          tone="secondary"
          onClick={() => onChange({ ...values, [`${defaultKey}${entries.length + 1}`]: defaultExpression() })}
        >
          {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.add.field")}
        </Button>
      </Inline>
      {entries.map(([key, value], index) => (
        <Stack key={`${key}-${index}`} gap={2}>
          <Inline gap={2}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.field.key")}
              value={key}
              onChange={(event) => setEntryKey(index, event.currentTarget.value)}
            />
            <Button
              size="sm"
              tone="secondary"
              onClick={() => onChange(Object.fromEntries(insertItem(entries, index + 1, [`${key}Copy`, value])))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.duplicate")}
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(Object.fromEntries(removeItem(entries, index)))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.remove")}
            </Button>
          </Inline>
          <MappingExpressionEditor
            label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.value.value", {
              value0: String(path),
              value1: String(key),
            })}
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
        <Heading level={6}>{t("catalog.features.sourceObservations.ui.mappingExpressionEditor.transforms")}</Heading>
        <Button size="sm" tone="secondary" onClick={() => onChange([...transforms, defaultTransform("coerce")])}>
          {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.add.transform")}
        </Button>
      </Inline>
      {transforms.map((transform, index) => (
        <Stack key={index} gap={2}>
          <Inline gap={2}>
            <Text element="span" size="sm" tone="secondary" weight="semibold">
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.transform")}
              {index + 1}
            </Text>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === 0}
              onClick={() => onChange(moveItem(transforms, index, index - 1))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.up")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={index === transforms.length - 1}
              onClick={() => onChange(moveItem(transforms, index, index + 1))}
            >
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.down")}
            </Button>
            <Button size="sm" tone="secondary" onClick={() => onChange(insertItem(transforms, index + 1, transform))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.duplicate")}
            </Button>
            <Button size="sm" tone="danger" onClick={() => onChange(removeItem(transforms, index))}>
              {t("catalog.features.sourceObservations.ui.mappingExpressionEditor.remove")}
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
        label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.transform.kind")}
        value={transform.kind}
        items={TRANSFORM_KIND_OPTIONS}
        onValueChange={(kind) => onChange(defaultTransform(kind))}
      />
      {transform.kind === "named-transform" ? (
        <>
          <Select
            label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.transform.function")}
            value={transform.functionKey}
            items={RUNTIME_FUNCTION_OPTIONS}
            onValueChange={(functionKey) => onChange({ ...transform, functionKey })}
          />
          <TextInput
            label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.transform.reason")}
            value={transform.reason}
            onChange={(event) => onChange({ ...transform, reason: event.currentTarget.value })}
          />
        </>
      ) : null}
      {transform.kind === "coerce" ? (
        <Select
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.coerce.to")}
          value={transform.to}
          items={COERCE_OPTIONS}
          onValueChange={(to) =>
            onChange({ ...transform, to: to as Extract<MappingExpressionTransform, { kind: "coerce" }>["to"] })
          }
        />
      ) : null}
      {transform.kind === "string" ? (
        <Select
          label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.string.operation")}
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
            label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.lookup.table")}
            value={transform.tableKey}
            onChange={(event) => onChange({ ...transform, tableKey: event.currentTarget.value })}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.mappingExpressionEditor.unknown.policy")}
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
    <CheckboxGroup
      label={legend}
      items={options.map((option) => ({ value: option, label: option }))}
      values={[...selected]}
      onValuesChange={onChange}
    />
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

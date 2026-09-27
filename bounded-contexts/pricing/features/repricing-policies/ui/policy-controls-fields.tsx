import {
  Banner,
  Button,
  CheckboxGroup,
  Fieldset,
  SegmentedControl,
  Select,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  RepricingAnchor,
  RepricingFloor,
  RepricingPolicyScope,
  RepricingRuleCondition,
  RepricingRuleDirective,
} from "../domain/domain";
import { policyControls } from "./policy-controls";

export type PolicyCategory = Readonly<{ id: string; name: string }>;
export const editorCopy = (key: string) => t(`pricing.features.repricingPolicies.ui.editor.${key}`);
export const controlItems = (options: Record<string, { copyKey: string }>) =>
  Object.entries(options).map(([value, option]) => ({ value, label: t(option.copyKey) }));

export function PolicyNumber({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <TextInput
      label={label}
      type="number"
      step="any"
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ""}
      onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
    />
  );
}

export function PolicyFloorFields({
  value,
  onChange,
}: {
  value: RepricingFloor;
  onChange: (value: RepricingFloor) => void;
}) {
  return (
    <Stack gap={3}>
      <Select
        label={editorCopy("floor")}
        items={controlItems(policyControls.floor)}
        value={value.mode}
        onValueChange={(mode) =>
          onChange(
            mode === "absolute"
              ? { mode, amount: "" }
              : { mode: "cost-basis-plus-margin", marginPercent: 10, absoluteFallbackAmount: "" },
          )
        }
      />
      {value.mode === "absolute" ? (
        <TextInput
          label={editorCopy("floor.amount")}
          inputMode="decimal"
          value={value.amount}
          onChange={(e) => onChange({ ...value, amount: e.currentTarget.value })}
        />
      ) : (
        <>
          <PolicyNumber
            label={editorCopy("floor.margin")}
            value={value.marginPercent}
            onChange={(marginPercent) => onChange({ ...value, marginPercent })}
          />
          <TextInput
            label={editorCopy("floor.fallback")}
            description={editorCopy("floor.costHelp")}
            inputMode="decimal"
            value={value.absoluteFallbackAmount}
            onChange={(e) => onChange({ ...value, absoluteFallbackAmount: e.currentTarget.value })}
          />
        </>
      )}
    </Stack>
  );
}

export function PolicyScopeFields({
  value,
  categories,
  onChange,
}: {
  value: RepricingPolicyScope;
  categories: readonly PolicyCategory[];
  onChange: (value: RepricingPolicyScope) => void;
}) {
  return (
    <Stack gap={3}>
      <Select
        label={editorCopy("scope")}
        items={controlItems(policyControls.scope)}
        value={value.kind}
        onValueChange={(kind) =>
          onChange(
            kind === "catalog-filter"
              ? { kind, categoryIds: [] }
              : kind === "listing-set"
                ? { kind, listingIds: [] }
                : { kind: "all-listings" },
          )
        }
      />
      {value.kind === "catalog-filter" ? (
        <CheckboxGroup
          label={editorCopy("scope.categories")}
          items={categories.map(({ id, name }) => ({ value: id, label: name }))}
          values={[...value.categoryIds]}
          onValuesChange={(categoryIds) => onChange({ ...value, categoryIds })}
        />
      ) : null}
      {value.kind === "listing-set" ? (
        <TextInput
          label={editorCopy("scope.listingIds")}
          value={value.listingIds.join(",")}
          onChange={(e) => onChange({ ...value, listingIds: e.currentTarget.value.split(",") })}
        />
      ) : null}
    </Stack>
  );
}

export function newPolicyCondition(type: RepricingRuleCondition["type"]): RepricingRuleCondition {
  switch (type) {
    case "category":
      return { type, categoryId: "" };
    case "item-grading":
      return { type, grading: "raw" };
    case "quantity-at-least":
      return { type, quantity: NaN };
    case "listing-age-at-least":
      return { type, days: NaN };
    case "competing-listing-count-at-least":
      return { type, count: NaN };
    case "schedule-window":
      return { type, daysOfWeek: [], startTime: "", endTime: "" };
    case "cost-basis-present":
    case "cost-basis-absent":
      return { type };
  }
}

export function PolicyConditionFields({
  value,
  categories,
  onChange,
}: {
  value: RepricingRuleCondition;
  categories: readonly PolicyCategory[];
  onChange: (value: RepricingRuleCondition) => void;
}) {
  const label = t(policyControls.condition[value.type].copyKey);
  switch (value.type) {
    case "category":
      return (
        <Select
          label={label}
          placeholder={editorCopy("choose")}
          items={categories.map(({ id, name }) => ({ value: id, label: name }))}
          value={value.categoryId}
          onValueChange={(categoryId) => onChange({ ...value, categoryId })}
        />
      );
    case "item-grading":
      return (
        <SegmentedControl
          label={label}
          items={[
            { value: "raw", label: editorCopy("grading.raw") },
            { value: "graded", label: editorCopy("grading.graded") },
          ]}
          value={value.grading}
          onValueChange={(grading) => onChange({ ...value, grading: grading === "graded" ? "graded" : "raw" })}
        />
      );
    case "quantity-at-least":
      return (
        <PolicyNumber label={label} value={value.quantity} onChange={(quantity) => onChange({ ...value, quantity })} />
      );
    case "listing-age-at-least":
      return <PolicyNumber label={label} value={value.days} onChange={(days) => onChange({ ...value, days })} />;
    case "competing-listing-count-at-least":
      return <PolicyNumber label={label} value={value.count} onChange={(count) => onChange({ ...value, count })} />;
    case "cost-basis-present":
    case "cost-basis-absent":
      return (
        <SegmentedControl
          label={editorCopy("costBasis")}
          items={controlItems({
            "cost-basis-present": policyControls.condition["cost-basis-present"],
            "cost-basis-absent": policyControls.condition["cost-basis-absent"],
          })}
          value={value.type}
          onValueChange={(type) => onChange({ type: type === "cost-basis-present" ? type : "cost-basis-absent" })}
        />
      );
    case "schedule-window":
      return (
        <Stack gap={3}>
          <CheckboxGroup
            label={label}
            items={Array.from({ length: 7 }, (_, day) => ({ value: String(day), label: editorCopy(`weekday.${day}`) }))}
            values={value.daysOfWeek.map(String)}
            onValuesChange={(days) => onChange({ ...value, daysOfWeek: days.map(Number) })}
          />
          <TextInput
            label={editorCopy("schedule.start")}
            type="time"
            value={value.startTime}
            onChange={(e) => onChange({ ...value, startTime: e.currentTarget.value })}
          />
          <TextInput
            label={editorCopy("schedule.end")}
            type="time"
            value={value.endTime}
            onChange={(e) => onChange({ ...value, endTime: e.currentTarget.value })}
          />
        </Stack>
      );
  }
}

function newAnchor(source: string): RepricingAnchor {
  return source === "comp-percentile"
    ? { source, percentile: NaN }
    : source === "lowest-competing-ask"
      ? { source: "lowest-competing-ask" }
      : source === "last-sold"
        ? { source: "last-sold" }
        : { source: "market-estimate" };
}

export function PolicyDirectiveFields({
  value,
  advanced,
  onChange,
}: {
  value: RepricingRuleDirective;
  advanced: boolean;
  onChange: (value: RepricingRuleDirective) => void;
}) {
  const changeAnchor = (index: number, anchor: RepricingAnchor) =>
    onChange({ ...value, anchorChain: value.anchorChain.map((old, i) => (i === index ? anchor : old)) });
  return (
    <Stack gap={4}>
      <TextInput
        label={editorCopy("currency")}
        value={value.currencyCode ?? ""}
        onChange={(e) => onChange({ ...value, currencyCode: e.currentTarget.value })}
      />
      {value.anchorChain.map((anchor, index) => (
        <Fieldset
          key={index}
          legend={t("pricing.features.repricingPolicies.ui.editor.anchor.number", { number: index + 1 })}
        >
          <Stack gap={3}>
            <Select
              label={editorCopy("anchor")}
              items={controlItems(policyControls.anchor)}
              value={anchor.source}
              onValueChange={(source) => changeAnchor(index, newAnchor(source))}
            />
            {anchor.source === "comp-percentile" ? (
              <PolicyNumber
                label={editorCopy("percentile")}
                value={anchor.percentile}
                min={1}
                max={99}
                onChange={(percentile) => changeAnchor(index, { ...anchor, percentile })}
              />
            ) : null}
            {advanced && anchor.source === "lowest-competing-ask" ? (
              <Select
                label={editorCopy("stratum")}
                items={[
                  { value: "hard", label: editorCopy("stratum.hard") },
                  { value: "any", label: editorCopy("stratum.any") },
                ]}
                value={anchor.strata ?? "hard"}
                onValueChange={(strata) =>
                  changeAnchor(
                    index,
                    strata === "any"
                      ? {
                          source: "lowest-competing-ask",
                          strata,
                          band: { ground: "market-estimate", minPercentOfGround: NaN },
                        }
                      : { source: "lowest-competing-ask", strata: "hard" },
                  )
                }
              />
            ) : null}
            {anchor.source === "lowest-competing-ask" && anchor.strata === "any" ? (
              <>
                <Banner tone="info" title={editorCopy("band.title")} description={editorCopy("band.description")} />
                <PolicyNumber
                  label={editorCopy("band.minimum")}
                  value={anchor.band.minPercentOfGround}
                  min={50}
                  max={100}
                  onChange={(minPercentOfGround) =>
                    changeAnchor(index, { ...anchor, band: { ground: "market-estimate", minPercentOfGround } })
                  }
                />
              </>
            ) : null}
            <Stack direction="row" gap={2}>
              <Button
                tone="ghost"
                disabled={index === 0}
                onClick={() => {
                  const anchors = [...value.anchorChain];
                  [anchors[index - 1], anchors[index]] = [anchors[index]!, anchors[index - 1]!];
                  onChange({ ...value, anchorChain: anchors });
                }}
              >
                {editorCopy("moveUp")}
              </Button>
              <Button
                tone="ghost"
                onClick={() => onChange({ ...value, anchorChain: value.anchorChain.filter((_, i) => i !== index) })}
              >
                {editorCopy("removeAnchor")}
              </Button>
            </Stack>
          </Stack>
        </Fieldset>
      ))}
      <Button
        tone="secondary"
        onClick={() => onChange({ ...value, anchorChain: [...value.anchorChain, { source: "market-estimate" }] })}
      >
        {editorCopy("addAnchor")}
      </Button>
      <Select
        label={editorCopy("offset")}
        items={controlItems(policyControls.offset)}
        value={value.offset.mode}
        onValueChange={(mode) =>
          onChange({ ...value, offset: mode === "percent" ? { mode, percent: NaN } : { mode: "absolute", amount: "" } })
        }
      />
      {value.offset.mode === "percent" ? (
        <PolicyNumber
          label={editorCopy("offset.percent")}
          value={value.offset.percent}
          onChange={(percent) => onChange({ ...value, offset: { mode: "percent", percent } })}
        />
      ) : (
        <TextInput
          label={editorCopy("offset.amount")}
          value={value.offset.amount}
          onChange={(e) => onChange({ ...value, offset: { mode: "absolute", amount: e.currentTarget.value } })}
        />
      )}
      <PolicyFloorFields value={value.floor} onChange={(floor) => onChange({ ...value, floor })} />
      <Select
        label={editorCopy("ceiling")}
        items={controlItems(policyControls.ceiling)}
        value={value.ceiling?.mode ?? "none"}
        onValueChange={(mode) =>
          onChange({
            ...value,
            ceiling:
              mode === "none" ? null : mode === "percent" ? { mode, percent: NaN } : { mode: "absolute", amount: "" },
          })
        }
      />
      {value.ceiling?.mode === "percent" ? (
        <PolicyNumber
          label={editorCopy("ceiling.percent")}
          value={value.ceiling.percent}
          onChange={(percent) => onChange({ ...value, ceiling: { mode: "percent", percent } })}
        />
      ) : null}
      {value.ceiling?.mode === "absolute" ? (
        <TextInput
          label={editorCopy("ceiling.amount")}
          value={value.ceiling.amount}
          onChange={(e) => onChange({ ...value, ceiling: { mode: "absolute", amount: e.currentTarget.value } })}
        />
      ) : null}
      <Select
        label={editorCopy("tolerance")}
        items={controlItems(policyControls.tolerance)}
        value={value.tolerance.mode}
        onValueChange={(mode) =>
          onChange({
            ...value,
            tolerance: mode === "percent" ? { mode, percent: NaN } : { mode: "absolute", amount: "" },
          })
        }
      />
      {value.tolerance.mode === "percent" ? (
        <PolicyNumber
          label={editorCopy("tolerance.percent")}
          value={value.tolerance.percent}
          onChange={(percent) => onChange({ ...value, tolerance: { mode: "percent", percent } })}
        />
      ) : (
        <TextInput
          label={editorCopy("tolerance.amount")}
          value={value.tolerance.amount}
          onChange={(e) => onChange({ ...value, tolerance: { mode: "absolute", amount: e.currentTarget.value } })}
        />
      )}
      <Select
        label={editorCopy("rounding")}
        items={controlItems(policyControls.rounding)}
        value={value.rounding.mode}
        onValueChange={(mode) =>
          onChange({
            ...value,
            rounding: mode === "increment" ? { mode, incrementAmount: "" } : { mode: mode === "charm" ? mode : "none" },
          })
        }
      />
      {value.rounding.mode === "increment" ? (
        <TextInput
          label={editorCopy("rounding.amount")}
          value={value.rounding.incrementAmount}
          onChange={(e) =>
            onChange({ ...value, rounding: { mode: "increment", incrementAmount: e.currentTarget.value } })
          }
        />
      ) : null}
      <TextInput
        label={editorCopy("maxMove")}
        type="number"
        value={value.maxMovePercent ?? ""}
        onChange={(e) =>
          onChange({ ...value, maxMovePercent: e.currentTarget.value === "" ? null : e.currentTarget.valueAsNumber })
        }
      />
      <Select
        label={editorCopy("terminal")}
        items={controlItems(policyControls.terminal)}
        value={value.terminal.kind}
        onValueChange={(kind) =>
          onChange({
            ...value,
            terminal:
              kind === "pause"
                ? { kind, reason: "" }
                : kind === "fallback-price"
                  ? { kind, amount: "" }
                  : { kind: kind === "notify-only" || kind === "price-at-floor" ? kind : "hold" },
          })
        }
      />
      {value.terminal.kind === "pause" ? (
        <TextInput
          label={editorCopy("terminal.reason")}
          value={value.terminal.reason}
          onChange={(e) => onChange({ ...value, terminal: { kind: "pause", reason: e.currentTarget.value } })}
        />
      ) : null}
      {value.terminal.kind === "fallback-price" ? (
        <TextInput
          label={editorCopy("terminal.amount")}
          value={value.terminal.amount}
          onChange={(e) => onChange({ ...value, terminal: { kind: "fallback-price", amount: e.currentTarget.value } })}
        />
      ) : null}
    </Stack>
  );
}

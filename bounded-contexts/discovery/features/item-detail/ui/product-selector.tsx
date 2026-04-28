import {
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ProductSchema } from "../../../support/client-support/contracts";
import {
  getOptionLabel,
  getOrderedActiveDimensions,
} from "../domain/product-resolution";

const ANY_OPTION_VALUE = "__any__";

function formatDimensionName(name: string): string {
  return name;
}

interface ProductSelectorProps {
  schema: ProductSchema;
  selections: Record<string, string>;
  optionSummaries?: Record<string, Record<string, string>>;
  onSelectionChange: (dimensionId: string, optionId: string) => void;
}

export function ProductSelector({
  schema,
  selections,
  optionSummaries = {},
  onSelectionChange,
}: ProductSelectorProps) {
  if (schema.dimensions.length === 0) {
    return null;
  }

  const orderedDimensions = getOrderedActiveDimensions(schema, selections);

  return (
    <Stack gap={4}>
      {orderedDimensions.map((dimension) => {
        const selected = selections[dimension.dimensionId] ?? ANY_OPTION_VALUE;
        const items = [
          {
            value: ANY_OPTION_VALUE,
            label: "Any",
          },
          ...dimension.allowedOptions.map((option) => ({
            value: option.optionId,
            label: getOptionLabel(option),
            description: optionSummaries[dimension.dimensionId]?.[option.optionId],
          })),
        ];
        const onValueChange = (value: string) =>
          onSelectionChange(
            dimension.dimensionId,
            value === ANY_OPTION_VALUE ? "" : value,
          );

        if (dimension.allowedOptions.length <= 5) {
          return (
            <Stack key={dimension.dimensionId} gap={2}>
              <Text size="sm" weight="semibold">
                {formatDimensionName(dimension.dimensionName)}
              </Text>
              <SegmentedControl
                items={items.map((item) => {
                  const description =
                    "description" in item ? item.description : undefined;

                  return {
                    ...item,
                    label: description
                      ? `${item.label} · ${description}`
                      : item.label,
                  };
                })}
                value={selected}
                onValueChange={onValueChange}
              />
            </Stack>
          );
        }

        return (
          <Select
            key={dimension.dimensionId}
            label={formatDimensionName(dimension.dimensionName)}
            items={items}
            value={selected}
            onValueChange={onValueChange}
          />
        );
      })}
    </Stack>
  );
}

import {
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { VersionSchema } from "../../../support/client-support/contracts";
import {
  getOptionLabel,
  getOrderedActiveDimensions,
} from "../domain/versioning";

function formatDimensionName(name: string): string {
  return name.toLowerCase() === "form" ? "Version type" : name;
}

interface ProductSelectorProps {
  schema: VersionSchema;
  selections: Record<string, string>;
  onSelectionChange: (dimensionId: string, optionId: string) => void;
}

export function ProductSelector({
  schema,
  selections,
  onSelectionChange,
}: ProductSelectorProps) {
  if (schema.dimensions.length === 0) {
    return null;
  }

  const orderedDimensions = getOrderedActiveDimensions(schema, selections);

  return (
    <Stack gap={4}>
      {orderedDimensions.map((dimension) => {
        const selected = selections[dimension.dimensionId] ?? "";

        if (dimension.allowedOptions.length <= 5) {
          return (
            <Stack key={dimension.dimensionId} gap={2}>
              <Text size="sm" weight="semibold">
                {formatDimensionName(dimension.dimensionName)}
              </Text>
              <SegmentedControl
                items={dimension.allowedOptions.map((option) => ({
                  value: option.optionId,
                  label: getOptionLabel(option),
                }))}
                value={selected}
                onValueChange={(value) =>
                  onSelectionChange(dimension.dimensionId, value)
                }
              />
            </Stack>
          );
        }

        return (
          <Select
            key={dimension.dimensionId}
            label={formatDimensionName(dimension.dimensionName)}
            items={dimension.allowedOptions.map((option) => ({
              value: option.optionId,
              label: getOptionLabel(option),
            }))}
            value={selected}
            onValueChange={(value) =>
              onSelectionChange(dimension.dimensionId, value)
            }
          />
        );
      })}
    </Stack>
  );
}

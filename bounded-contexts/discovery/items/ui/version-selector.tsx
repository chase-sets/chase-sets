import {
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { VersionSchema } from "./contracts";

interface VersionSelectorProps {
  schema: VersionSchema;
  selections: Record<string, string>;
  onSelectionChange: (dimensionId: string, choiceId: string) => void;
}

export function VersionSelector({
  schema,
  selections,
  onSelectionChange,
}: VersionSelectorProps) {
  if (schema.dimensions.length === 0) {
    return null;
  }

  const orderedDimensions = schema.canonicalDimensionOrder.map((order) =>
    schema.dimensions.find((d) => d.dimensionId === order.dimensionId)
  ).filter((d): d is NonNullable<typeof d> => d !== undefined);

  return (
    <Stack gap={4}>
      {orderedDimensions.map((dimension) => {
        const selected = selections[dimension.dimensionId] ?? "";
        const choiceLabel = (choice: typeof dimension.allowedChoices[0]) => {
          if (choice.labels && choice.labels.length > 0) {
            return choice.labels[0].value;
          }
          return choice.code;
        };

        if (dimension.allowedChoices.length <= 5) {
          return (
            <Stack key={dimension.dimensionId} gap={2}>
              <Text size="sm" weight="semibold">{dimension.dimensionName}</Text>
              <SegmentedControl
                items={dimension.allowedChoices.map((choice) => ({
                  value: choice.choiceId,
                  label: choiceLabel(choice),
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
            label={dimension.dimensionName}
            items={dimension.allowedChoices.map((choice) => ({
              value: choice.choiceId,
              label: choiceLabel(choice),
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





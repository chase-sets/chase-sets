import {
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { VersionSchema } from "../../../support/client-support/contracts";
import {
  getChoiceLabel,
  getOrderedActiveDimensions,
} from "../domain/versioning";

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

  const orderedDimensions = getOrderedActiveDimensions(schema, selections);

  return (
    <Stack gap={4}>
      {orderedDimensions.map((dimension) => {
        const selected = selections[dimension.dimensionId] ?? "";

        if (dimension.allowedChoices.length <= 5) {
          return (
            <Stack key={dimension.dimensionId} gap={2}>
              <Text size="sm" weight="semibold">{dimension.dimensionName}</Text>
              <SegmentedControl
                items={dimension.allowedChoices.map((choice) => ({
                  value: choice.choiceId,
                  label: getChoiceLabel(choice),
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
              label: getChoiceLabel(choice),
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

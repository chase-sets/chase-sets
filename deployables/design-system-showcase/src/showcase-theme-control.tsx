import {
  type ColorMode,
  Inline,
  SegmentedControl,
  Text
} from "@chase-sets/design-system";

export interface ShowcaseThemeControlProps {
  colorMode: ColorMode;
  onColorModeChange: (value: ColorMode) => void;
}

export function ShowcaseThemeControl({
  colorMode,
  onColorModeChange
}: ShowcaseThemeControlProps) {
  return (
    <Inline gap={2} align="center">
      <Text size="sm" tone="secondary">
        Theme
      </Text>
      <SegmentedControl
        value={colorMode}
        onValueChange={(value) => onColorModeChange(value as ColorMode)}
        items={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" }
        ]}
      />
    </Inline>
  );
}

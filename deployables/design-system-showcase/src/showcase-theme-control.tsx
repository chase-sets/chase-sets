import {
  type ColorMode,
  Inline,
  type ReducedMotionSetting,
  SegmentedControl,
  Text
} from "@chase-sets/design-system";

export interface ShowcaseThemeControlProps {
  colorMode: ColorMode;
  onColorModeChange: (value: ColorMode) => void;
  reducedMotion: ReducedMotionSetting;
  onReducedMotionChange: (value: ReducedMotionSetting) => void;
}

export function ShowcaseThemeControl({
  colorMode,
  onColorModeChange,
  reducedMotion,
  onReducedMotionChange
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
      <Text size="sm" tone="secondary">
        Motion
      </Text>
      <SegmentedControl
        value={reducedMotion}
        onValueChange={(value) => onReducedMotionChange(value as ReducedMotionSetting)}
        items={[
          { value: "user", label: "System" },
          { value: "never", label: "Full" },
          { value: "always", label: "Reduced" }
        ]}
      />
    </Inline>
  );
}

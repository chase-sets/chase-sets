import {
  createContext,
  useContext,
  useState,
  type HTMLAttributes,
  type PropsWithChildren
} from "react";
import { cx } from "../utils/cx";
import {
  resolveThemeOverrideStyle,
  type ColorMode,
  type DensityMode,
  type ThemeOverrides
} from "./tokens";

interface PortalContextValue {
  overlayNode: HTMLDivElement | null;
  toastNode: HTMLDivElement | null;
}

const DensityContext = createContext<DensityMode>("comfortable");
const MotionContext = createContext(false);
const PortalContext = createContext<PortalContextValue>({
  overlayNode: null,
  toastNode: null
});

type RootFrameProps = Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">;

export interface ChaseRootProps extends PropsWithChildren, RootFrameProps {
  density?: DensityMode;
  reducedMotion?: boolean;
  colorMode?: ColorMode;
  theme?: ThemeOverrides;
}

export function ChaseRoot({
  children,
  density = "comfortable",
  reducedMotion = false,
  colorMode = "system",
  theme,
  ...rest
}: ChaseRootProps) {
  const [overlayNode, setOverlayNode] = useState<HTMLDivElement | null>(null);
  const [toastNode, setToastNode] = useState<HTMLDivElement | null>(null);

  return (
    <DensityContext.Provider value={density}>
      <MotionContext.Provider value={reducedMotion}>
        <PortalContext.Provider value={{ overlayNode, toastNode }}>
          <div
            {...rest}
            data-chase-theme=""
            data-color-mode={colorMode}
            data-density={density}
            data-reduced-motion={reducedMotion ? "true" : "false"}
            className={cx(
              "chase-root relative isolate min-h-screen bg-background font-body text-foreground"
            )}
            style={resolveThemeOverrideStyle(theme)}
          >
            {children}
            <div ref={setOverlayNode} data-chase-overlay-root="" />
            <div ref={setToastNode} data-chase-toast-root="" />
          </div>
        </PortalContext.Provider>
      </MotionContext.Provider>
    </DensityContext.Provider>
  );
}

export interface ThemeScopeProps
  extends PropsWithChildren,
    RootFrameProps {
  colorMode?: ColorMode;
  theme?: ThemeOverrides;
}

export function ThemeScope({
  children,
  colorMode,
  theme,
  ...rest
}: ThemeScopeProps) {
  return (
    <div
      {...rest}
      data-chase-theme=""
      data-chase-theme-scope=""
      data-color-mode={colorMode}
      className="contents"
      style={resolveThemeOverrideStyle(theme)}
    >
      {children}
    </div>
  );
}

export function useDensity(): DensityMode {
  return useContext(DensityContext);
}

export function useReducedMotion(): boolean {
  return useContext(MotionContext);
}

export function usePortalRoots(): PortalContextValue {
  return useContext(PortalContext);
}

export interface ColorModeToggleProps {
  value: ColorMode;
  onValueChange: (mode: ColorMode) => void;
  lightLabel?: string;
  darkLabel?: string;
  systemLabel?: string;
}

const colorModeOrder: ColorMode[] = ["light", "dark", "system"];

export function ColorModeToggle({
  value,
  onValueChange,
  lightLabel = "Light",
  darkLabel = "Dark",
  systemLabel = "System"
}: ColorModeToggleProps) {
  const labels: Record<ColorMode, string> = {
    light: lightLabel,
    dark: darkLabel,
    system: systemLabel
  };

  function cycle() {
    const index = colorModeOrder.indexOf(value);
    const next = colorModeOrder[(index + 1) % colorModeOrder.length];
    onValueChange(next);
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="focus-ring inline-flex touch-target items-center gap-2 rounded-tokenMd border border-muted bg-elevated px-3 py-2 text-sm font-medium text-secondary shadow-tokenSm transition hover:text-foreground"
    >
      {labels[value]}
    </button>
  );
}

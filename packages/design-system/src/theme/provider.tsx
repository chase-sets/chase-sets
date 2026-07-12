import {
  createContext,
  useEffect,
  useContext,
  useMemo,
  useSyncExternalStore,
  useState,
  type HTMLAttributes,
  type PropsWithChildren,
} from "react";
import { MotionConfig } from "motion/react";
import { resolveChaseMotion, type ChaseMotionSettings, type ReducedMotionSetting } from "../motion/config";
import { cx } from "../utils/cx";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../components/control-sizing";
import { AnchorLink, LinkAdapterProvider, type LinkComponent } from "./link-adapter";
import { resolveThemeOverrideStyle, type ColorMode, type DensityMode, type ThemeOverrides } from "./tokens";

interface PortalContextValue {
  overlayNode: HTMLDivElement | null;
  toastNode: HTMLDivElement | null;
}

const DensityContext = createContext<DensityMode>("comfortable");
const MotionContext = createContext<ChaseMotionSettings>(resolveChaseMotion(undefined, "user", false));
const PortalContext = createContext<PortalContextValue>({
  overlayNode: null,
  toastNode: null,
});

type RootFrameProps = Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">;

export interface ChaseRootProps extends PropsWithChildren, RootFrameProps {
  density?: DensityMode;
  reducedMotion?: ReducedMotionSetting;
  colorMode?: ColorMode;
  theme?: ThemeOverrides;
  /**
   * The component DS nav surfaces (NavigationItem, LinkButton, Breadcrumbs, ...) render
   * hrefs through. Defaults to a plain `<a>` (full document navigation). Apps with a
   * router register it once here — see `RouterLinkAdapter` in
   * `@chase-sets/design-system/react-router` for the React Router 7 implementation.
   */
  linkComponent?: LinkComponent;
}

function subscribeToReducedMotion(callback: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const listener = () => callback();

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }

  mediaQuery.addListener(listener);
  return () => mediaQuery.removeListener(listener);
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ChaseRoot({
  children,
  density = "comfortable",
  reducedMotion = "user",
  colorMode = "system",
  theme,
  linkComponent = AnchorLink,
  ...rest
}: ChaseRootProps) {
  const [overlayNode, setOverlayNode] = useState<HTMLDivElement | null>(null);
  const [toastNode, setToastNode] = useState<HTMLDivElement | null>(null);
  const [hasMounted, setHasMounted] = useState(false);
  const systemReducedMotion = useSyncExternalStore(subscribeToReducedMotion, getReducedMotionSnapshot, () => false);
  const resolvedReducedMotion =
    reducedMotion === "always" ? true : reducedMotion === "never" ? false : hasMounted && systemReducedMotion;
  const motionSettings = useMemo(
    () => resolveChaseMotion(theme, reducedMotion, resolvedReducedMotion),
    [theme, reducedMotion, resolvedReducedMotion],
  );
  const motionReducedMotion = resolvedReducedMotion ? "always" : "never";

  useEffect(() => {
    setHasMounted(true);
  }, []);

  return (
    <LinkAdapterProvider value={linkComponent}>
      <DensityContext.Provider value={density}>
        <MotionContext.Provider value={motionSettings}>
          <PortalContext.Provider value={{ overlayNode, toastNode }}>
            <MotionConfig
              reducedMotion={motionReducedMotion}
              transition={{
                duration: motionSettings.durations.base,
                ease: motionSettings.easing,
              }}
            >
              <div
                {...rest}
                data-chase-theme=""
                data-color-mode={colorMode}
                data-density={density}
                data-reduced-motion={resolvedReducedMotion ? "true" : "false"}
                className={cx(
                  "chase-root relative isolate min-h-screen w-full min-w-0 max-w-full overflow-x-clip bg-background font-body text-foreground",
                )}
                style={resolveThemeOverrideStyle(theme)}
              >
                {children}
                <div ref={setOverlayNode} data-chase-overlay-root="" />
                <div ref={setToastNode} data-chase-toast-root="" />
              </div>
            </MotionConfig>
          </PortalContext.Provider>
        </MotionContext.Provider>
      </DensityContext.Provider>
    </LinkAdapterProvider>
  );
}

export interface ThemeScopeProps extends PropsWithChildren, RootFrameProps {
  colorMode?: ColorMode;
  theme?: ThemeOverrides;
}

export function ThemeScope({ children, colorMode, theme, ...rest }: ThemeScopeProps) {
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
  return useContext(MotionContext).reducedMotion;
}

export function useChaseMotion(): ChaseMotionSettings {
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
  systemLabel = "System",
}: ColorModeToggleProps) {
  const labels: Record<ColorMode, string> = {
    light: lightLabel,
    dark: darkLabel,
    system: systemLabel,
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
      className={cx(
        "focus-ring inline-flex items-center gap-2 rounded-tokenMd border border-muted bg-elevated font-medium text-secondary shadow-tokenSm transition hover:text-foreground",
        controlHeightClasses.md,
        controlPaddingClasses.md,
        controlTextClasses.md,
      )}
    >
      {labels[value]}
    </button>
  );
}

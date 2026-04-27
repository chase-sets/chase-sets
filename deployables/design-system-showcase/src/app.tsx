import { useState } from "react";
import {
  ChaseRoot,
  type ColorMode,
  type ReducedMotionSetting,
  Page,
  Surface,
  Tabs,
  Text,
  ToastRegion
} from "@chase-sets/design-system";
import { ShowcaseThemeControl } from "./showcase-theme-control";
import { AdminView } from "./views/admin-view";
import { ComponentsView } from "./views/components-view";
import { MarketplaceView } from "./views/marketplace-view";

type ShowcaseMode = "marketplace" | "admin" | "components";

function resolveInitialShowcaseMode(): ShowcaseMode {
  if (typeof window === "undefined") {
    return "marketplace";
  }

  const view = new URLSearchParams(window.location.search).get("view");
  return view === "admin" || view === "components" ? view : "marketplace";
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const [reducedMotion, setReducedMotion] = useState<ReducedMotionSetting>("user");
  const [showcaseMode, setShowcaseMode] = useState<ShowcaseMode>(resolveInitialShowcaseMode);
  const [isDemoToastOpen, setIsDemoToastOpen] = useState(false);

  return (
    <ChaseRoot colorMode={colorMode} reducedMotion={reducedMotion}>
      <Page>
        <Surface padding={3}>
          <Tabs
            value={showcaseMode}
            onValueChange={(value) => setShowcaseMode(value as ShowcaseMode)}
            items={[
              {
                value: "marketplace",
                label: "Marketplace",
                content: null
              },
              {
                value: "admin",
                label: "Seller Dashboard",
                content: null
              },
              {
                value: "components",
                label: "Design System",
                content: null
              }
            ]}
          />
          <Text size="sm" tone="secondary">
            Showcase controls
          </Text>
          <ShowcaseThemeControl
            colorMode={colorMode}
            onColorModeChange={setColorMode}
            reducedMotion={reducedMotion}
            onReducedMotionChange={setReducedMotion}
          />
        </Surface>
      </Page>
      {showcaseMode === "marketplace" ? (
        <MarketplaceView />
      ) : showcaseMode === "admin" ? (
        <AdminView />
      ) : (
        <ComponentsView />
      )}
      <ToastRegion
        items={[
          {
            id: "demo-toast",
            title: "Design system ready",
            description:
              "Marketplace and admin surfaces are rendering from a shared package with an explicit stylesheet import.",
            tone: "success",
            open: isDemoToastOpen,
            onOpenChange: setIsDemoToastOpen
          }
        ]}
      />
    </ChaseRoot>
  );
}

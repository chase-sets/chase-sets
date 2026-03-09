import { useState } from "react";
import {
  ChaseRoot,
  type ColorMode,
  type ReducedMotionSetting,
  Page,
  PageHeader,
  Surface,
  Tabs,
  ToastRegion
} from "@chase-sets/design-system";
import { ShowcaseThemeControl } from "./showcase-theme-control";
import { AdminView } from "./views/admin-view";
import { ComponentsView } from "./views/components-view";
import { MarketplaceView } from "./views/marketplace-view";

type ShowcaseMode = "marketplace" | "admin" | "components";

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const [reducedMotion, setReducedMotion] = useState<ReducedMotionSetting>("user");
  const [showcaseMode, setShowcaseMode] = useState<ShowcaseMode>("marketplace");
  const [isDemoToastOpen, setIsDemoToastOpen] = useState(true);

  return (
    <ChaseRoot colorMode={colorMode} reducedMotion={reducedMotion}>
      <Page>
        <Surface elevated>
          <PageHeader
            eyebrow="Design system"
            title="One package, shared marketplace and admin surfaces"
            description="The showcase validates theme tokens, layout primitives, and responsive application shells from a single explicit stylesheet contract."
            actions={
              <ShowcaseThemeControl
                colorMode={colorMode}
                onColorModeChange={setColorMode}
                reducedMotion={reducedMotion}
                onReducedMotionChange={setReducedMotion}
              />
            }
          />
        </Surface>
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
              label: "Admin",
              content: null
            },
            {
              value: "components",
              label: "Components",
              content: null
            }
          ]}
        />
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

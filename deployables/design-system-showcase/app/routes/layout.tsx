import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  ChaseRoot,
  type ColorMode,
  type ReducedMotionSetting,
  Page,
  PageHeader,
  Surface,
  Tabs,
  ToastRegion,
} from "@chase-sets/design-system";
import { ShowcaseThemeControl } from "../../src/showcase-theme-control";

function resolveMode(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment === "admin" || segment === "components"
    ? segment
    : "marketplace";
}

export default function ShowcaseLayoutRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const [reducedMotion, setReducedMotion] = useState<ReducedMotionSetting>("user");
  const [isDemoToastOpen, setIsDemoToastOpen] = useState(true);
  const showcaseMode = resolveMode(location.pathname);

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
          onValueChange={(value) =>
            navigate(value === "marketplace" ? "/" : `/${value}`)
          }
          items={[
            {
              value: "marketplace",
              label: "Marketplace",
              content: null,
            },
            {
              value: "admin",
              label: "Admin",
              content: null,
            },
            {
              value: "components",
              label: "Components",
              content: null,
            },
          ]}
        />
      </Page>
      <Outlet />
      <ToastRegion
        items={[
          {
            id: "demo-toast",
            title: "Design system ready",
            description:
              "Marketplace and admin surfaces are rendering from a shared package with an explicit stylesheet import.",
            tone: "success",
            open: isDemoToastOpen,
            onOpenChange: setIsDemoToastOpen,
          },
        ]}
      />
    </ChaseRoot>
  );
}

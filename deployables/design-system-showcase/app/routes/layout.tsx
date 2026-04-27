import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  ChaseRoot,
  type ColorMode,
  type ReducedMotionSetting,
  Page,
  Surface,
  Tabs,
  Text,
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
  const showcaseMode = resolveMode(location.pathname);

  return (
    <ChaseRoot colorMode={colorMode} reducedMotion={reducedMotion}>
      <Page>
        <Surface padding={3}>
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
              label: "Seller Dashboard",
              content: null,
            },
            {
              value: "components",
              label: "Design System",
              content: null,
            },
          ]}
        />
      </Page>
      <Outlet />
    </ChaseRoot>
  );
}

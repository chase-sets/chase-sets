import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation } from "react-router";
import { Button, Form, Inline } from "@chase-sets/design-system";
import { ExperienceAdminLayout } from "@chase-sets/experience/web";
import { requireExperienceAdminActor } from "../auth.server";
import { resolveAdminWebNavItems, resolveAdminWebSectionNavItems } from "../host";

function resolveActiveKey(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments[1] || "platform-feedback";
}

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await requireExperienceAdminActor(request, ["platform-feedback.view", "public-presence.view"]),
  };
}

export default function ExperienceAdminLayoutRoute() {
  const location = useLocation();
  const { actor } = useLoaderData<typeof loader>();

  return (
    <ExperienceAdminLayout
      topNavItems={resolveAdminWebSectionNavItems(actor)}
      topNavActiveKey="experience"
      activeKey={resolveActiveKey(location.pathname)}
      navItems={resolveAdminWebNavItems(actor, { section: "experience" })}
      actions={
        <Inline gap={2}>
          <Form action="/identity/sign-out" method="post" spacing="none">
            <Button type="submit" tone="secondary">
              {t("adminWeb.app.routes.experienceLayout.sign.out")}
            </Button>
          </Form>
        </Inline>
      }
    >
      <Outlet />
    </ExperienceAdminLayout>
  );
}

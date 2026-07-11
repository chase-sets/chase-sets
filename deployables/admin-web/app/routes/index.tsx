import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import { Grid, Heading, Stack, Card, EmptyState, LinkButton, Page, PageHeader } from "@chase-sets/design-system";
import {
  createIdentityRequestApiClient,
  createUserPreferencesColorModeCookieSeedHeaders,
  requestWithoutFreshWrite,
  resolveIdentityShellViewer,
  type CurrentActorDisplay,
  type IdentityShellViewer,
} from "@chase-sets/identity/server";
import { resolveAdminActorDisplay } from "../actor-display.server";
import { requireSignedInAdminActor } from "../auth.server";
import { resolveAdminWebSectionNavItems } from "../host";
import { AdminRootShell } from "../admin-root-shell";

type AdminIndexLoaderData = Readonly<{
  actor: Awaited<ReturnType<typeof requireSignedInAdminActor>>;
  actorDisplay?: CurrentActorDisplay | null;
  sections: ReturnType<typeof resolveAdminWebSectionNavItems>;
  viewer: IdentityShellViewer;
}>;

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireSignedInAdminActor(request);
  const sections = resolveAdminWebSectionNavItems(actor);

  if (sections.length === 1 && sections[0]?.href) {
    throw redirect(sections[0].href);
  }

  const [viewer, actorDisplay] = await Promise.all([
    resolveIdentityShellViewer(createIdentityRequestApiClient(requestWithoutFreshWrite(request)), actor),
    resolveAdminActorDisplay(request),
  ]);
  const payload = {
    actor,
    actorDisplay,
    sections,
    viewer,
  };
  const cookieHeaders = createUserPreferencesColorModeCookieSeedHeaders(request, viewer.preferences?.colorMode);

  return cookieHeaders ? data(payload, { headers: cookieHeaders }) : payload;
}

export default function AdminIndexRoute() {
  const { actor, actorDisplay, sections, viewer } = useLoaderData() as AdminIndexLoaderData;

  if (sections.length === 0) {
    return (
      <AdminRootShell actor={actor} actorDisplay={actorDisplay} sections={sections} viewer={viewer}>
        <Page width="content">
          <EmptyState
            icon="lock"
            title={t("adminWeb.app.routes.index.no.admin.sections.available")}
            description={t(
              "adminWeb.app.routes.index.your.account.is.signed.in.but.it.does.not.have.permission.to.view.any.admin.sections",
            )}
          />
        </Page>
      </AdminRootShell>
    );
  }

  return (
    <AdminRootShell actor={actor} actorDisplay={actorDisplay} sections={sections} viewer={viewer}>
      <Page>
        <PageHeader
          eyebrow={t("adminWeb.app.routes.index.admin")}
          title={t("adminWeb.app.routes.index.admin.sections")}
          description={t(
            "adminWeb.app.routes.index.choose.a.section.to.continue.with.the.tools.available.to.your.account",
          )}
        />
        <Grid columns={{ base: 1, md: 2, xl: 3 }} gap={4}>
          {sections.map((section) => (
            <Card key={section.key} interactive>
              <Stack gap={3}>
                <Heading level={4}>{section.label}</Heading>
                <LinkButton href={section.href ?? "/"} tone="primary">
                  {t("adminWeb.app.routes.index.open")}
                </LinkButton>
              </Stack>
            </Card>
          ))}
        </Grid>
      </Page>
    </AdminRootShell>
  );
}

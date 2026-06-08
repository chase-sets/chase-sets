import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  Grid,
  Heading,
  Stack,
  Card,
  ChaseRoot,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
} from "@chase-sets/design-system";
import { requireSignedInAdminActor } from "../auth.server";
import { resolveAdminWebSectionNavItems } from "../host";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireSignedInAdminActor(request);
  const sections = resolveAdminWebSectionNavItems(actor);

  if (sections.length === 1 && sections[0]?.href) {
    throw redirect(sections[0].href);
  }

  return { sections };
}

export default function AdminIndexRoute() {
  const { sections } = useLoaderData<typeof loader>();

  if (sections.length === 0) {
    return (
      <ChaseRoot>
        <Page width="content">
          <EmptyState
            icon="lock"
            title={t("adminWeb.app.routes.index.no.admin.sections.available")}
            description={t(
              "adminWeb.app.routes.index.your.account.is.signed.in.but.it.does.not.have.permission.to.view.any.admin.sections",
            )}
          />
        </Page>
      </ChaseRoot>
    );
  }

  return (
    <ChaseRoot>
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
    </ChaseRoot>
  );
}

import { redirect, type LoaderFunctionArgs } from "react-router";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import type { NavigationItem } from "@chase-sets/design-system";
import { requireAdminSectionActor } from "./auth.server";
import { resolveAdminWebNavItems, resolveAdminWebRouteFallbackPermission } from "./host";

type SectionLoaderConfig = Readonly<{
  section: WebHostSection;
  fallbackPermission: string;
}>;

function firstNavigationHref(items: readonly NavigationItem[]): string | undefined {
  for (const item of items) {
    if (item.href) {
      return item.href;
    }

    const childHref = firstNavigationHref(item.children ?? []);
    if (childHref) {
      return childHref;
    }
  }

  return undefined;
}

export function createAdminSectionLoader(config: SectionLoaderConfig) {
  return async function loader({ request }: LoaderFunctionArgs) {
    const fallbackPermission = resolveAdminWebRouteFallbackPermission(
      config.section,
      new URL(request.url).pathname,
      config.fallbackPermission,
    );

    return {
      actor: await requireAdminSectionActor(request, config.section, fallbackPermission),
    };
  };
}

export function createAdminSectionHomeLoader(config: SectionLoaderConfig) {
  return async function loader({ request }: LoaderFunctionArgs) {
    const actor = await requireAdminSectionActor(request, config.section, "");
    const firstVisibleItemHref = firstNavigationHref(resolveAdminWebNavItems(actor, { section: config.section }));

    if (!firstVisibleItemHref) {
      throw new Response("Forbidden.", { status: 403 });
    }

    throw redirect(firstVisibleItemHref);
  };
}

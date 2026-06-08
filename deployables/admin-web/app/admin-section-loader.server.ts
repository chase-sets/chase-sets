import { redirect, type LoaderFunctionArgs } from "react-router";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { requireAdminSectionActor } from "./auth.server";
import { resolveAdminWebNavItems } from "./host";

type SectionLoaderConfig = Readonly<{
  section: WebHostSection;
  fallbackPermission: string;
}>;

export function createAdminSectionLoader(config: SectionLoaderConfig) {
  return async function loader({ request }: LoaderFunctionArgs) {
    return {
      actor: await requireAdminSectionActor(request, config.section, config.fallbackPermission),
    };
  };
}

export function createAdminSectionHomeLoader(config: SectionLoaderConfig) {
  return async function loader({ request }: LoaderFunctionArgs) {
    const actor = await requireAdminSectionActor(request, config.section, config.fallbackPermission);
    const firstVisibleItem = resolveAdminWebNavItems(actor, { section: config.section })[0];

    if (!firstVisibleItem?.href) {
      throw new Response("Forbidden.", { status: 403 });
    }

    throw redirect(firstVisibleItem.href);
  };
}

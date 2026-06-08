import type { LoaderFunctionArgs } from "react-router";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { requireAdminSectionActor } from "./auth.server";

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

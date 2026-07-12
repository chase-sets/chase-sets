import type { ComponentProps } from "react";
import { HelpArticlePage } from "../../features/help/ui/help-pages";

/** Cross-context public-web composition seam for canonical public articles. */
export function PublicHelpArticlePage(props: ComponentProps<typeof HelpArticlePage>) {
  return <HelpArticlePage {...props} />;
}

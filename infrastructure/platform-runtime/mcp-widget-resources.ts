import { createPublicProductUrlPolicy } from "./public-product-urls";
import { UCP_MCP_APP_RESOURCE_MIME_TYPE, UCP_MCP_PRODUCT_CARDS_RESOURCE_URI } from "./ucp-contracts";

export type McpWidgetResourceProvider = (uri: string) => string | undefined;

const originMarker = 'name="chase-sets-public-origins" content=""';

export function mcpWidgetResourceContent(request: Request, uri: string, html: string, description: string) {
  const isProductCards = uri === UCP_MCP_PRODUCT_CARDS_RESOURCE_URI;
  const origins = isProductCards ? createPublicProductUrlPolicy(request).origins : [];
  return {
    uri,
    mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
    text: isProductCards
      ? html.replace(originMarker, () =>
          originMarker.replace('content=""', `content="${encodeURIComponent(JSON.stringify(origins))}"`),
        )
      : html,
    _meta: {
      ui: { csp: { connectDomains: [], resourceDomains: origins }, prefersBorder: true },
      "openai/widgetDescription": description,
    },
  };
}

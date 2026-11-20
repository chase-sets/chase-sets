import { createPublicProductUrlPolicy } from "./public-product-urls";
import { UCP_MCP_APP_RESOURCE_MIME_TYPE } from "./ucp-contracts";

export type McpWidgetResourceProvider = (uri: string) => string | undefined;

const originMarker = 'name="chase-sets-public-origins" content=""';

export function mcpWidgetResourceContent(request: Request, uri: string, html: string, description: string) {
  const { origins } = createPublicProductUrlPolicy(request);
  return {
    uri,
    mimeType: UCP_MCP_APP_RESOURCE_MIME_TYPE,
    text: html.replace(originMarker, () =>
      originMarker.replace('content=""', `content="${encodeURIComponent(JSON.stringify(origins))}"`),
    ),
    _meta: {
      ui: { csp: { connectDomains: [], resourceDomains: origins }, prefersBorder: true },
      "openai/widgetDescription": description,
    },
  };
}

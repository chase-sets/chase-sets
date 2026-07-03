export function isNativeMcpAnonymousDiscoveryAccepted(response) {
  return response.status === 200;
}

export function readNativeMcpBearerResourceMetadataUrl(response) {
  const header = response?.headers?.get?.("WWW-Authenticate") ?? response?.headers?.get?.("www-authenticate") ?? "";
  const match = /\bBearer\b.*\bresource_metadata="([^"]+)"/i.exec(header);
  return match?.[1] ?? null;
}

export function isNativeMcpProtectedResourceChallenge(response) {
  return response.status === 401 && readNativeMcpBearerResourceMetadataUrl(response) !== null;
}

export function isNativeMcpPermissionBoundaryError(error, expectedPermission) {
  return error?.message === `Missing required permission: ${expectedPermission}.`;
}

export function readNativeMcpToolStructuredContent(result) {
  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent;
  }

  const textBlock = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === "text" && typeof entry.text === "string")
    : null;
  if (!textBlock) {
    return null;
  }

  try {
    const parsed = JSON.parse(textBlock.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

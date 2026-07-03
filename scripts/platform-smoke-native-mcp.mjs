export function isNativeMcpAnonymousDiscoveryRejected(response) {
  return [401, 403, 405].includes(response.status);
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

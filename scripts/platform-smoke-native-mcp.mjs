export function isNativeMcpAnonymousDiscoveryRejected(response) {
  return [401, 403, 405].includes(response.status);
}

export function isNativeMcpPermissionBoundaryError(error, expectedPermission) {
  return error?.message === `Missing required permission: ${expectedPermission}.`;
}

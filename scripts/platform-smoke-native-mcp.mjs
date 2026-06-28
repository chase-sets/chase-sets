export function isNativeMcpAnonymousDiscoveryRejected(response) {
  return [401, 403, 405].includes(response.status);
}

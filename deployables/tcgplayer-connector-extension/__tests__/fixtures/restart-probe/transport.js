export const holdOrigin = "http://127.0.0.1:46173";

export function admitOrigin(candidate) {
  if (candidate !== holdOrigin) throw new Error("Only the exact synthetic hold origin is admitted");
}

export function createTransport(manifest, registry) {
  for (const host of manifest.host_permissions ?? []) {
    if (host !== `${holdOrigin}/*`) throw new Error("Non-loopback or non-exact host permission");
  }
  for (const origin of registry) admitOrigin(origin);
  return async function hold() {
    if (!manifest.host_permissions?.includes(`${holdOrigin}/*`) || !registry.includes(holdOrigin)) {
      throw new Error("Synthetic hold origin missing from permission or registry");
    }
    return fetch(`${holdOrigin}/hold`, { credentials: "omit", redirect: "error" });
  };
}

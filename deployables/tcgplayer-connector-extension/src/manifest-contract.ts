export type ProbeManifest = Readonly<{
  manifest_version: 3;
  name: string;
  version: string;
  key: string;
  background: Readonly<{ service_worker: "background.js"; type: "module" }>;
  permissions: readonly ["identity", "storage"];
  action: Readonly<{ default_popup: "popup.html" }>;
  sandbox: Readonly<{ pages: readonly ["popup-sandboxed.html"] }>;
  content_security_policy: Readonly<{ extension_pages: string; sandbox: string }>;
}>;

export function createProbeManifestForKey(publicKey: string): ProbeManifest {
  return {
    manifest_version: 3,
    name: "Chase Sets TCGplayer Connector Chromium Authority Probe",
    version: "0.1.0",
    key: publicKey,
    background: { service_worker: "background.js", type: "module" },
    permissions: ["identity", "storage"],
    action: { default_popup: "popup.html" },
    sandbox: { pages: ["popup-sandboxed.html"] },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
      sandbox: "sandbox allow-scripts allow-popups; script-src 'self'; object-src 'none'",
    },
  };
}

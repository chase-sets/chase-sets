import { describe, expect, it } from "vitest";
import { assertConnectorManifest, buildConnectorManifest, connectorPermissions } from "../domain/connector-manifest";
import { TCGPLAYER_CONNECTOR_EXTENSION_KEY } from "../domain/identity";

const input = { platformOrigin: "http://localhost:6182", hostRegistry: [], permissionRegistry: connectorPermissions };

describe("extension-mv3-manifest-contract", () => {
  it("pins the minimal closed MV3 manifest and only the platform host", () => {
    const manifest = buildConnectorManifest(input);
    expect(manifest).toEqual({
      manifest_version: 3,
      name: "Chase Sets TCGplayer Connector",
      version: "0.1.0",
      key: TCGPLAYER_CONNECTOR_EXTENSION_KEY,
      background: { service_worker: "background.js", type: "module" },
      permissions: ["identity", "storage", "alarms"],
      host_permissions: ["http://localhost:6182/*"],
      action: { default_title: "unpaired" },
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
    });
    expect(() => assertConnectorManifest(manifest, input)).not.toThrow();
    const { key: _key, ...withoutKey } = manifest;
    expect(() => assertConnectorManifest(withoutKey, input)).toThrow("connector-manifest-graph-refused");
  });

  it.each([
    "https://*.example.com",
    "<all_urls>",
    "https://example.com/*",
    "http://example.com",
    "https://user@example.com",
    "https://example.com/path",
  ])("refuses origin %s", (platformOrigin) => {
    expect(() => buildConnectorManifest({ ...input, platformOrigin })).toThrow();
  });

  it.each(["<all_urls>", "cookies", "tabs", "webRequest", "webRequestBlocking", "downloads", "unknown"])(
    "refuses unregistered permission %s",
    (permission) => {
      expect(() =>
        buildConnectorManifest({ ...input, permissionRegistry: [...connectorPermissions, permission] }),
      ).toThrow();
    },
  );

  it("admits only exact capture-cited hosts and rejects nested unknown fields", () => {
    const entry = {
      origin: "https://captured.example",
      capture: "https://github.com/chase-sets/chase-sets/issues/4388#issuecomment-5621479167",
    };
    expect(buildConnectorManifest({ ...input, hostRegistry: [entry] }).host_permissions).toContain(`${entry.origin}/*`);
    for (const mutant of [
      { ...entry, capture: "" },
      { ...entry, extra: true },
      { ...entry, origin: "https://*.example" },
    ])
      expect(() => buildConnectorManifest({ ...input, hostRegistry: [mutant] })).toThrow();
    expect(() =>
      buildConnectorManifest({ ...input, permissionRegistry: ["identity", "identity", "alarms"] }),
    ).toThrow();
    expect(() => buildConnectorManifest({ ...input, permissionRegistry: ["identity", "storage"] })).toThrow();
  });

  it.each([
    ["wildcard host", { host_permissions: ["https://*/*"] }],
    ["undefined pinned key", { key: undefined }],
    ["different pinned key", { key: "synthetic-unapproved-key" }],
    ["uncited host", { host_permissions: ["http://localhost:6182/*", "https://provider.example/*"] }],
    ["all urls", { host_permissions: ["<all_urls>"] }],
    ["cookies", { permissions: ["identity", "storage", "alarms", "cookies"] }],
    ["tabs", { permissions: ["identity", "storage", "alarms", "tabs"] }],
    ["CSP", { content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'none'" } }],
    ["external messages", { externally_connectable: { matches: ["https://example.com/*"] } }],
    ["remote code", { background: { service_worker: "https://example.com/background.js", type: "module" } }],
    ["nested unknown", { background: { service_worker: "background.js", type: "module", extra: true } }],
    ["popup", { action: { default_title: "unpaired", default_popup: "popup.html" } }],
    ["HTML", { options_page: "options.html" }],
    ["sandbox", { sandbox: { pages: ["sandbox.html"] } }],
    ["unlisted entry", { content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }] }],
  ])("kills the single-field %s mutant with the same graph assertion", (_name, patch) => {
    const manifest = buildConnectorManifest(input);
    assertConnectorManifest(manifest, input);
    expect(() => assertConnectorManifest({ ...manifest, ...patch }, input)).toThrow("connector-manifest-graph-refused");
  });
});

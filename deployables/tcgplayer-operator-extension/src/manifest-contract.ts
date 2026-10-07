export const operatorExtensionId = "ghemdloifdkoadnapmigabiekchlholm";
export const operatorPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvBMv5xfZFqsgLsDHVgJsQE4oH5c+GbIgS1sB9zcwCT06+rCErQCyAFCdYW/CWbvQrzbNfZ2pSxNVlbF4+jSvNNcA+jC7xfsv20xDdWqcmT+4FFcDhDchzYNemi/E++Ru5OTFmYBDWjeYFtMHslO5s5he3/eXgVO9oWbePLhFkL0kiplFQfZNgC3qe9R1BKFjIMUIn0AM9HPMTpHsdOVA9rRfede3CdIEEi2fH0cTUHtQ9F8uFkvupCznOn9t4TdR0VMikx/dbNDtaHD+vAgotG/chEAcQlx1joKG9VwsZ4XtjpQbHQYLnWJCsis31bqOUpAaxh92NJIaEi2BLbEeaQIDAQAB";
export const operatorManifest = {
  manifest_version: 3,
  name: "Chase Sets TCGplayer Operator Extension",
  version: "0.1.0",
  key: operatorPublicKey,
  incognito: "not_allowed",
  permissions: ["cookies", "storage", "alarms"],
  host_permissions: [
    "https://store.tcgplayer.com/*",
    "https://admin.staging.chasesets.com/*",
    "https://admin.chasesets.com/*",
  ],
  background: { service_worker: "background.js", type: "module" },
  action: { default_popup: "popup.html" },
  sandbox: { pages: ["sandbox.html"] },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'",
    sandbox: "sandbox allow-scripts; script-src 'self'; object-src 'none'",
  },
} as const;

export function isOperatorManifest(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(operatorManifest);
}

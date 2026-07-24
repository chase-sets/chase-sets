import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([".git", "artifacts", "build", "coverage", "dist", "node_modules"]);
const scanRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages", "scripts"];
const supportedClassifications = new Set([
  "authenticated-identity-administration",
  "bootstrap-reconciliation-test",
  "canonical-client",
  "composition-root",
  "composition-root-contract-test",
  "development-seed",
  "e2e-registration-scenario",
  "guest-checkout-nonregistration",
  "identity-domain-command",
  "identity-registration-boundary",
  "identity-registration-client",
  "identity-registration-contract-test",
  "preactivation-direct-client",
  "production-bootstrap",
  "registration-client-observer-test",
  "registration-route",
  "registration-ui-adapter",
  "test-support-bootstrap",
  "unrelated-route-fixture",
]);

const surfacePatterns = new Map([
  ["auth-register-http", /\/api\/auth\/register|buildUrl\(\s*["']register["']\s*\)/],
  ["identity-personal-identity", /\bcreatePersonalIdentity\s*\(/],
  ["identity-personal-identity-http", /personal-identities/],
  ["identity-guest-account", /\.createGuestAccount\s*\(/],
  ["identity-guest-user", /\.createUser\s*\(/],
  ["identity-aggregate-create", /\btype\s*:\s*["']Create(?:Account|User)["']/],
]);
const supportedSurfaces = new Set([...surfacePatterns.keys(), "auth-register-method"]);
supportedSurfaces.add("registration-helper-call");
supportedSurfaces.add("registration-helper-definition");

const registrationConsentCallerInventory = [
  {
    file: "bounded-contexts/auth/client.ts",
    classification: "canonical-client",
    surfaces: ["auth-register-http"],
    binding: "createAuthApiClient registration-consent resolution and exact submission methods",
  },
  {
    file: "bounded-contexts/auth/support/route-support/auth-host.ts",
    classification: "registration-ui-adapter",
    surfaces: ["auth-register-method"],
    binding: "Auth form adapter through createAuthRequestApiClient",
  },
  ...[
    "bounded-contexts/auth/support/api-support/invitation-routes.ts",
    "bounded-contexts/auth/support/api-support/magic-link-routes.ts",
    "bounded-contexts/auth/support/api-support/passkey-routes.ts",
    "bounded-contexts/auth/support/api-support/phone-code-routes.ts",
    "bounded-contexts/auth/support/api-support/register-routes.ts",
    "bounded-contexts/auth/support/api-support/social-login-routes.ts",
  ].map((file) => ({
    file,
    classification: "registration-route",
    surfaces: ["identity-personal-identity"],
    binding: "IdentityAuthMutationClient.createPersonalIdentity",
  })),
  ...[
    "deployables/marketplace/e2e/support/auth.ts",
    "scripts/guest-buy-now-freshness-probe.mjs",
    "scripts/stripe-money-smoke-test.mjs",
  ].map((file) => ({
    file,
    classification: "preactivation-direct-client",
    surfaces:
      file === "deployables/marketplace/e2e/support/auth.ts"
        ? ["auth-register-http", "registration-helper-definition"]
        : ["auth-register-http"],
    binding: "empty pre-activation bundle; must move to the canonical client when activation lands",
  })),
  ...["scripts/guest-buy-now-freshness-probe.test.mjs", "scripts/stripe-money-smoke-test.test.mjs"].map((file) => ({
    file,
    classification: "registration-client-observer-test",
    surfaces: ["auth-register-http"],
    binding: "observes the classified registration client without creating another transport",
  })),
  ...[
    "deployables/marketplace/app/smoke-auth-support.test.ts",
    "deployables/marketplace/e2e/support/auth-trace-artifact.probe.spec.ts",
  ].map((file) => ({
    file,
    classification: "registration-client-observer-test",
    surfaces: ["auth-register-http", "registration-helper-call"],
    binding: "invokes and observes the canonical marketplace E2E registration helper",
  })),
  ...[
    "deployables/marketplace/e2e/account-payment.spec.ts",
    "deployables/marketplace/e2e/buy-funnel-redesign.spec.ts",
    "deployables/marketplace/e2e/critical-flows.spec.ts",
    "deployables/marketplace/e2e/sell-list-evidence.spec.ts",
    "deployables/marketplace/e2e/seller-desk-journey.uat.spec.ts",
  ].map((file) => ({
    file,
    classification: "e2e-registration-scenario",
    surfaces: ["registration-helper-call"],
    binding: "delegates first-use creation to deployables/marketplace/e2e/support/auth.ts",
  })),
  {
    file: "deployables/platform-api/src/app.ts",
    classification: "composition-root",
    surfaces: ["auth-register-http"],
    binding: "thin mount of the Auth-owned registration route",
  },
  {
    file: "deployables/platform-api/__tests__/app.test.ts",
    classification: "composition-root-contract-test",
    surfaces: ["auth-register-http"],
    binding: "in-process contract probe of the mounted Auth route",
  },
  {
    file: "infrastructure/bounded-context-runtime/write-consistency-middleware.test.ts",
    classification: "unrelated-route-fixture",
    surfaces: ["auth-register-http"],
    binding: "synthetic route name used only to probe generic write-consistency middleware",
  },
  {
    file: "bounded-contexts/identity/api.ts",
    classification: "identity-registration-boundary",
    surfaces: ["identity-aggregate-create", "identity-personal-identity-http"],
    binding: "Identity-owned internal Auth command boundary",
  },
  {
    file: "bounded-contexts/identity/server.ts",
    classification: "identity-registration-client",
    surfaces: ["identity-personal-identity-http"],
    binding: "IdentityAuthMutationClient canonical internal transport",
  },
  ...["bounded-contexts/identity/tests/api-mutation-snapshots.test.ts"].map((file) => ({
    file,
    classification: "identity-registration-contract-test",
    surfaces: ["identity-personal-identity-http"],
    binding: "in-process contract probe of the Identity internal Auth boundary",
  })),
  {
    file: "bounded-contexts/identity/tests/internal-auth-routes.test.ts",
    classification: "identity-registration-contract-test",
    surfaces: ["identity-aggregate-create", "identity-personal-identity-http"],
    binding: "in-process contract probe of the Identity internal Auth boundary",
  },
  {
    file: "bounded-contexts/auth/support/api-support/guest-checkout-routes.ts",
    classification: "guest-checkout-nonregistration",
    surfaces: ["identity-guest-account", "identity-guest-user"],
    binding: "guest checkout lifecycle, not personal-identity registration",
  },
  ...[
    "bounded-contexts/identity/features/accounts/api/route.ts",
    "bounded-contexts/identity/features/users/api/route.ts",
  ].map((file) => ({
    file,
    classification: "authenticated-identity-administration",
    surfaces: ["identity-aggregate-create"],
    binding: "permission-guarded Identity administration, not Auth first-use registration",
  })),
  ...[
    "bounded-contexts/identity/features/accounts/domain/domain.ts",
    "bounded-contexts/identity/features/accounts/domain/domain.test.ts",
    "bounded-contexts/identity/features/users/domain/domain.ts",
    "bounded-contexts/identity/features/users/domain/domain.test.ts",
  ].map((file) => ({
    file,
    classification: "identity-domain-command",
    surfaces: ["identity-aggregate-create"],
    binding: "Identity aggregate command definition or domain control",
  })),
  {
    file: "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts",
    classification: "test-support-bootstrap",
    surfaces: ["identity-aggregate-create"],
    binding: "declared admin QA actor fixture provisioning",
  },
  {
    file: "bounded-contexts/identity/support/runtime-support/production-bootstrap.ts",
    classification: "production-bootstrap",
    surfaces: ["identity-aggregate-create"],
    binding: "idempotent platform-admin bootstrap, outside public registration",
  },
  {
    file: "bounded-contexts/identity/support/runtime-support/seed.ts",
    classification: "development-seed",
    surfaces: ["identity-aggregate-create"],
    binding: "Identity-owned development seed graph",
  },
  {
    file: "deployables/platform-api/__tests__/bootstrap-production-reconciliation.db.test.ts",
    classification: "bootstrap-reconciliation-test",
    surfaces: ["identity-aggregate-create"],
    binding: "database-backed seed/bootstrap reconciliation control",
  },
];

export { registrationConsentCallerInventory };

function normalizeRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function walkSourceFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function discoverSurfaces(content) {
  const surfaces = [];
  for (const [surface, pattern] of surfacePatterns) {
    if (pattern.test(content)) {
      surfaces.push(surface);
    }
  }
  if (
    /\b(?:createAuthApiClient|createAuthRequestApiClient|authApi)\b/.test(content) &&
    /\.\s*register(?:<[^>]+>)?\s*\(/.test(content)
  ) {
    surfaces.push("auth-register-method");
  }
  if (/(?:export\s+)?async\s+function\s+registerOrSignInSyntheticAccount\s*\(/.test(content)) {
    surfaces.push("registration-helper-definition");
  }
  const withoutRegistrationHelperDefinition = content.replace(
    /(?:export\s+)?async\s+function\s+registerOrSignInSyntheticAccount\s*\(/g,
    "",
  );
  if (/\bregisterOrSignInSyntheticAccount\s*\(/.test(withoutRegistrationHelperDefinition)) {
    surfaces.push("registration-helper-call");
  }
  return surfaces.sort();
}

function findCallArguments(content, callPattern) {
  const calls = [];
  for (const match of content.matchAll(callPattern)) {
    const openIndex = content.indexOf("(", match.index);
    if (openIndex < 0) {
      continue;
    }

    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = openIndex; index < content.length; index += 1) {
      const character = content[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(content.slice(openIndex + 1, index));
          break;
        }
      }
    }
  }
  return calls;
}

function validateCanonicalClient(file, content, violations) {
  const requiredShapes = [
    ["resolveRegistrationConsent", /resolveRegistrationConsent\s*\(/],
    ["authoritative registration method", /registerWithAuthoritativeConsent\s*</],
    ["exact-submission method", /registerWithConsentSubmission\s*</],
    ["authoritative resolution endpoint", /buildUrl\(\s*["']registration-consent["']\s*\)/],
    ["operation ID forwarding", /operationId\s*:\s*resolution\.operationId/],
    ["ordered snapshot forwarding", /snapshot\s*:\s*resolution\.snapshot/],
    ["affirmation forwarding", /affirmed\s*:\s*options\.affirmed/],
  ];
  for (const [label, pattern] of requiredShapes) {
    if (!pattern.test(content)) {
      violations.push(`${file}: canonical registration client is missing ${label}`);
    }
  }
}

function validateActivatedRegistrationBinding(entry, content, violations) {
  if (entry.classification === "registration-route") {
    const calls = findCallArguments(content, /\bcreatePersonalIdentity\s*\(/g);
    if (calls.length === 0) {
      violations.push(`${entry.file}: registered createPersonalIdentity caller could not be parsed`);
    }
    for (const [index, call] of calls.entries()) {
      if (!/\bregistrationConsent\s*:/.test(call) || !/\bregistrationConsentSubmission\s*\(/.test(call)) {
        violations.push(
          `${entry.file}: createPersonalIdentity call ${index + 1} must submit the exact canonical registrationConsent operation ID, ordered snapshot, and affirmation`,
        );
      }
    }
  }

  if (entry.classification === "registration-ui-adapter") {
    const calls = findCallArguments(content, /\bapi\.register(?:<[^>]+>)?\s*\(/g);
    if (calls.length === 0) {
      violations.push(`${entry.file}: registered Auth registration adapter caller could not be parsed`);
    }
    for (const [index, call] of calls.entries()) {
      if (!/\bregistrationConsent\s*:/.test(call) || !/\bregistrationConsentSubmission\s*\(/.test(call)) {
        violations.push(
          `${entry.file}: Auth registration adapter call ${index + 1} must forward the canonical registrationConsent submission`,
        );
      }
    }
  }

  if (entry.classification === "preactivation-direct-client") {
    violations.push(
      `${entry.file}: direct /api/auth/register client is forbidden after registration consent activation; use createAuthApiClient().registerWithAuthoritativeConsent`,
    );
  }
}

export function analyzeRegistrationConsentCallerSources(options) {
  const {
    sources,
    inventory = registrationConsentCallerInventory,
    activationEnabled = sources.some(
      ({ file, content }) =>
        file === "bounded-contexts/identity/server.ts" &&
        /\bregistrationConsent\s*:\s*RegistrationConsentSubmission\b/.test(content),
    ),
  } = options;
  const violations = [];
  const inventoryByFile = new Map();

  for (const entry of inventory) {
    if (!entry || typeof entry !== "object" || typeof entry.file !== "string" || !entry.file) {
      violations.push("registration-consent caller inventory entry must have a non-empty file");
      continue;
    }
    if (inventoryByFile.has(entry.file)) {
      violations.push(`${entry.file}: duplicate registration-consent caller inventory entry`);
      continue;
    }
    if (!supportedClassifications.has(entry.classification)) {
      violations.push(
        `${entry.file}: unsupported registration-consent caller classification '${entry.classification}'`,
      );
    }
    if (typeof entry.binding !== "string" || !entry.binding.trim()) {
      violations.push(`${entry.file}: registration-consent caller inventory binding must be non-empty`);
    }
    if (
      !Array.isArray(entry.surfaces) ||
      entry.surfaces.length === 0 ||
      entry.surfaces.some((surface) => !supportedSurfaces.has(surface)) ||
      new Set(entry.surfaces).size !== entry.surfaces.length
    ) {
      violations.push(`${entry.file}: registration-consent caller inventory surfaces must be unique supported values`);
    }
    inventoryByFile.set(entry.file, entry);
  }

  const sourceByFile = new Map(sources.map((source) => [source.file, source]));
  for (const source of sources) {
    const discovered = discoverSurfaces(source.content);
    const entry = inventoryByFile.get(source.file);
    if (discovered.length === 0) {
      if (entry) {
        violations.push(`${source.file}: stale caller inventory surface(s) ${[...entry.surfaces].sort().join(", ")}`);
      }
      continue;
    }

    if (!entry) {
      violations.push(
        `${source.file}: unknown first-use identity/account creation caller (${discovered.join(", ")}); classify it in the canonical registration-consent caller inventory`,
      );
      continue;
    }

    const expected = [...entry.surfaces].sort();
    const missing = discovered.filter((surface) => !expected.includes(surface));
    const stale = expected.filter((surface) => !discovered.includes(surface));
    if (missing.length > 0) {
      violations.push(
        `${source.file}: unclassified first-use surface(s) ${missing.join(", ")}; update the canonical caller inventory`,
      );
    }
    if (stale.length > 0) {
      violations.push(`${source.file}: stale caller inventory surface(s) ${stale.join(", ")}`);
    }

    if (entry.classification === "canonical-client") {
      validateCanonicalClient(source.file, source.content, violations);
    }
    if (activationEnabled) {
      validateActivatedRegistrationBinding(entry, source.content, violations);
    }
  }

  for (const entry of inventory) {
    if (!sourceByFile.has(entry.file)) {
      violations.push(`${entry.file}: stale registration-consent caller inventory entry; file does not exist`);
    }
  }

  return {
    ok: violations.length === 0,
    activationEnabled,
    inventory,
    violations,
  };
}

export function validateRegistrationConsentCallerInventory({ repoRoot }) {
  const sources = scanRoots
    .flatMap((root) => walkSourceFiles(path.join(repoRoot, root)))
    .filter(
      (file) =>
        !normalizeRelative(file, repoRoot).startsWith("scripts/check-structure/registration-consent-caller-inventory."),
    )
    .map((file) => ({
      file: normalizeRelative(file, repoRoot),
      content: readFileSync(file, "utf8"),
    }));
  return analyzeRegistrationConsentCallerSources({ sources });
}

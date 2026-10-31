import { execFileSync } from "node:child_process";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileFunction } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  collectIdentityCreationRegistryViolations,
  collectOpenSchemaObjectPaths,
  identityCreationDispositions,
  listIdentityCreationEntries,
  loadIdentityCreationPathRegistry,
  loadIdentityCreationPathRegistrySchema,
  validateAgainstSchema,
} from "./identity-creation-path-registry.mjs";

const registry = loadIdentityCreationPathRegistry();
const schema = loadIdentityCreationPathRegistrySchema();
// Parsed once so every landing control shares one source set and selector cache.
const registeredSources = parseRegisteredSources(registry);

function readSite(site) {
  const absolute = path.join(repoRoot, site.file);
  if (!existsSync(absolute)) {
    return null;
  }
  return readFileSync(absolute, "utf8").split(/\r?\n/);
}

describe("identity creation path registry", () => {
  it("validates against a recursively closed schema", () => {
    expect(collectOpenSchemaObjectPaths(schema)).toEqual([]);
    expect(validateAgainstSchema(registry, schema)).toEqual([]);
  });

  it("rejects an unknown member at every nesting level", () => {
    const withUnknownTopLevel = { ...registry, surprise: true };
    expect(validateAgainstSchema(withUnknownTopLevel, schema)).toContain('<root>: unknown member "surprise"');

    const withUnknownEntry = {
      ...registry,
      paths: [{ ...registry.paths[0], surprise: true }, ...registry.paths.slice(1)],
    };
    expect(validateAgainstSchema(withUnknownEntry, schema)).toContain('<root>/paths[0]: unknown member "surprise"');

    const withUnknownSite = {
      ...registry,
      paths: [
        { ...registry.paths[0], sites: [{ ...registry.paths[0].sites[0], surprise: true }] },
        ...registry.paths.slice(1),
      ],
    };
    expect(validateAgainstSchema(withUnknownSite, schema)).toContain(
      '<root>/paths[0]/sites[0]: unknown member "surprise"',
    );

    const withUnknownMember = {
      ...registry,
      compositions: [
        { ...registry.compositions[0], members: [{ ...registry.compositions[0].members[0], surprise: true }] },
      ],
    };
    expect(validateAgainstSchema(withUnknownMember, schema)).toContain(
      '<root>/compositions[0]/members[0]: unknown member "surprise"',
    );
  });

  it("gives every entry a disposition and a non-empty reason", () => {
    for (const entry of listIdentityCreationEntries(registry)) {
      expect(identityCreationDispositions.has(entry.disposition), `${entry.id} disposition`).toBe(true);
      expect(entry.reason.trim().length, `${entry.id} reason`).toBeGreaterThan(0);
    }
    expect(collectIdentityCreationRegistryViolations(registry, schema)).toEqual([]);
  });

  it("makes every temporary exemption name an owning issue", () => {
    const temporary = listIdentityCreationEntries(registry).filter((entry) => entry.disposition === "exempt-temporary");
    expect(temporary.length).toBeGreaterThan(0);
    for (const entry of temporary) {
      expect(typeof entry.owningIssue, `${entry.id} owner`).toBe("number");
    }
  });

  it("fails an entry whose reason is blank or whose temporary exemption has no owner", () => {
    const blankReason = {
      ...registry,
      paths: [{ ...registry.paths[0], reason: "   " }, ...registry.paths.slice(1)],
    };
    expect(collectIdentityCreationRegistryViolations(blankReason, schema)).toContain(
      `${registry.paths[0].id}: every entry needs a reason`,
    );

    const ownerless = { ...registry.compositions[0] };
    delete ownerless.owningIssue;
    const withoutOwner = { ...registry, compositions: [ownerless] };
    expect(collectIdentityCreationRegistryViolations(withoutOwner, schema)).toContain(
      `${ownerless.id}: every temporary exemption must name an owning issue`,
    );
  });

  it("binds all six public first-use paths and every direct register client", () => {
    const bound = registry.paths.filter((entry) => entry.disposition === "bound");
    expect(bound.filter((entry) => entry.kind === "public-first-use").map((entry) => entry.id)).toEqual([
      "password-direct-registration",
      "invitation-registration",
      "first-use-magic-link",
      "passkey-registration",
      "phone-code-registration",
      "social-login-first-use",
    ]);
    expect(bound.filter((entry) => entry.kind === "direct-register-client").map((entry) => entry.id)).toEqual([
      "marketplace-register-route-action",
      "marketplace-e2e-auth-helper",
      "guest-buy-now-freshness-probe",
      "stripe-money-smoke-test",
    ]);
  });

  it("keeps twenty unique identities in the 10/6/4 disposition and 6/4/3/1/2/2/1/1 kind partition", () => {
    const entries = [
      ...registry.paths.map(({ id, kind, disposition }) => [id, kind, disposition]),
      ...registry.compositions.map(({ id, disposition }) => [id, "composition", disposition]),
    ];
    expect(new Set(entries.map(([id]) => id)).size).toBe(20);
    expect(entries).toEqual([
      ["password-direct-registration", "public-first-use", "bound"],
      ["invitation-registration", "public-first-use", "bound"],
      ["first-use-magic-link", "public-first-use", "bound"],
      ["passkey-registration", "public-first-use", "bound"],
      ["phone-code-registration", "public-first-use", "bound"],
      ["social-login-first-use", "public-first-use", "bound"],
      ["marketplace-register-route-action", "direct-register-client", "bound"],
      ["marketplace-e2e-auth-helper", "direct-register-client", "bound"],
      ["guest-buy-now-freshness-probe", "direct-register-client", "bound"],
      ["stripe-money-smoke-test", "direct-register-client", "bound"],
      ["protected-account-administration", "protected-administration", "exempt-permanent"],
      ["protected-user-administration", "protected-administration", "exempt-permanent"],
      ["protected-membership-administration", "protected-administration", "exempt-permanent"],
      ["identity-domain-deciders", "domain-decider", "exempt-permanent"],
      ["identity-domain-decider-tests", "test-fixture", "exempt-permanent"],
      ["platform-api-bootstrap-reconciliation-db-test", "test-fixture", "exempt-permanent"],
      ["production-platform-admin-bootstrap", "operator-provisioning", "exempt-temporary"],
      ["admin-qa-actor-fixtures", "operator-provisioning", "exempt-temporary"],
      ["development-scenario-seed", "seed", "exempt-temporary"],
      ["guest-checkout-account-claim", "composition", "exempt-temporary"],
    ]);
  });

  it("forwards the fetched, unaffirmed registration consent submission from the marketplace register action", () => {
    const file = registry.paths.find(({ id }) => id === "marketplace-register-route-action").sites[0].file;
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    const violations = (...replacements) =>
      collectMarketplaceSubmissionViolations(parseMutant(file, text, replacements));
    const submission =
      /\n\s*registrationConsent: \{\s*resolution: await api\.getRegistrationConsent\(\),\s*affirmed: false,\s*\},/;

    expect(violations()).toEqual([]);
    expect(violations([submission, ""])).toEqual(["api.register must forward a registrationConsent object"]);
    // Resolving first and dropping the value keeps the route's fetch order but forwards nothing.
    expect(
      violations(
        [submission, ""],
        ["authResult = await api.register<", "await api.getRegistrationConsent();\nauthResult = await api.register<"],
      ),
    ).toEqual(["api.register must forward a registrationConsent object"]);
    expect(violations(["affirmed: false", "affirmed: true"])).toEqual(["affirmed must be false"]);
    expect(
      violations(["resolution: await api.getRegistrationConsent()", 'resolution: { bundleKey: "registration" }']),
    ).toEqual(["resolution must be the awaited api.getRegistrationConsent() result"]);
  });

  it("keeps guest checkout start and claim off the registration consent mint and submission", () => {
    const file = registry.compositions.find(({ id }) => id === "guest-checkout-account-claim").members[0].file;
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    const references = (...replacements) => collectRegistrationConsentReferences(parseMutant(file, text, replacements));

    expect(references()).toEqual([]);
    expect(
      references([
        "identityMutations.createGuestAccount({",
        "identityMutations.createGuestAccount({\nregistrationConsent: await resolveUnaffirmedRegistrationConsent(identityMutations),",
      ]),
    ).toEqual([
      "POST /guest-checkout/start: property registrationConsent",
      "POST /guest-checkout/start: call resolveUnaffirmedRegistrationConsent",
    ]);
    expect(
      references(
        [
          "getBootstrapContext, type AuthApiApp }",
          "getBootstrapContext, resolveUnaffirmedRegistrationConsent as mint, type AuthApiApp }",
        ],
        [
          "const existingUser = await services.identity.getUserByEmail(params.email);",
          "await mint(identityMutations);\nconst existingUser = await services.identity.getUserByEmail(params.email);",
        ],
      ),
    ).toEqual(["resolveClaimUser: call mint"]);
    expect(references(["identityMutations.createUser({", "identityMutations.createPersonalIdentity({"])).toEqual([
      "resolveClaimUser: call identityMutations.createPersonalIdentity",
    ]);
  });

  it("states that provisioning records no Consent and awaits no migration, in both creation registries", () => {
    const positions = JSON.parse(readFileSync(path.join(repoRoot, "scripts/identity-creation-positions.json"), "utf8"));
    const provisioningPaths = ["admin-qa-actor-fixtures", "development-scenario-seed"];
    const provisioningFiles = provisioningPaths.flatMap((id) =>
      registry.paths.find((entry) => entry.id === id).sites.map(({ file }) => file),
    );
    const staleProvisioningReasons = (pathEntries, positionEntries) =>
      [
        ...pathEntries.filter(({ id }) => provisioningPaths.includes(id)),
        ...positionEntries.filter((entry) => provisioningFiles.includes(entry.path)),
      ]
        .filter(
          ({ reason }) => /records? consent directly|must migrate/i.test(reason) || !/records no Consent/.test(reason),
        )
        .map(({ id, path: file, command }) => id ?? `${file}:${command}`);

    expect(staleProvisioningReasons(registry.paths, positions.positions)).toEqual([]);
    // Ids, dispositions and creation counts are unchanged by the removal.
    expect(
      provisioningPaths.map((id) => {
        const entry = registry.paths.find((candidate) => candidate.id === id);
        return [id, entry.disposition, entry.owningIssue, entry.sites.length];
      }),
    ).toEqual([
      ["admin-qa-actor-fixtures", "exempt-temporary", 5684, 3],
      ["development-scenario-seed", "exempt-temporary", 5684, 18],
    ]);
    expect(
      positions.positions
        .filter((entry) => provisioningFiles.includes(entry.path))
        .map(({ path: file, command, occurrences, disposition }) => [
          path.posix.basename(file),
          command,
          occurrences,
          disposition,
        ]),
    ).toEqual([
      ["admin-qa-actor-fixtures.ts", "CreateAccount", 1, "exempt-temporary"],
      ["admin-qa-actor-fixtures.ts", "CreateUser", 1, "exempt-temporary"],
      ["admin-qa-actor-fixtures.ts", "GrantMembership", 1, "exempt-temporary"],
      ["seed.ts", "CreateAccount", 6, "exempt-temporary"],
      ["seed.ts", "CreateUser", 6, "exempt-temporary"],
      ["seed.ts", "GrantMembership", 6, "exempt-temporary"],
    ]);

    const restoredPath = structuredClone(registry.paths);
    restoredPath.find(({ id }) => id === "admin-qa-actor-fixtures").reason =
      "Provisions QA actors and already records consent directly; must migrate to the consent bundle once one exists.";
    expect(staleProvisioningReasons(restoredPath, positions.positions)).toEqual(["admin-qa-actor-fixtures"]);
    const restoredPosition = structuredClone(positions.positions);
    restoredPosition.find((entry) => entry.path.endsWith("/seed.ts") && entry.command === "CreateUser").reason =
      "Development and scenario seeding creates non-production users and records consent directly; it must migrate with the consent bundle.";
    expect(staleProvisioningReasons(registry.paths, restoredPosition)).toEqual([
      "bounded-contexts/identity/support/runtime-support/seed.ts:CreateUser",
    ]);
  });

  it("registers guest checkout as one pinned composition exemption", () => {
    const guestCheckout = registry.compositions.find((entry) => entry.id === "guest-checkout-account-claim");
    expect(guestCheckout, "guest checkout must be classified, not omitted").toBeTruthy();
    expect(guestCheckout.disposition).toBe("exempt-temporary");
    expect(guestCheckout.members.map((member) => member.constructor).sort()).toEqual([
      "claimGuestAccount",
      "createGuestAccount",
      "createUser",
    ]);
    const landings = discoverLandingTargets(registry, registeredSources);
    for (const landing of landings.filter(({ entry }) => entry === guestCheckout)) {
      expect(readSite(landing.site), `${landing.site.file} must exist`).toBeTruthy();
      expect(landing.error, landing.label).toBeUndefined();
      expect(landing.operation, `${landing.site.file}:${landing.line}`).toContain(landing.site.constructor);
    }
  });

  it("pins every registered site to a file that still exists", () => {
    for (const entry of registry.paths) {
      for (const site of entry.sites) {
        expect(readSite(site), `${entry.id} -> ${site.file}`).toBeTruthy();
      }
    }
  });

  it("classifies every Auth caller of the personal-identity constructor", () => {
    // Registered positions are the sites' computed landings; the registry carries no line.
    const landings = discoverLandingTargets(registry, registeredSources);
    expect(landings.filter((landing) => landing.error)).toEqual([]);
    const registered = new Set(landings.map((landing) => `${landing.site.file}:${landing.line}`));
    const discovered = landings
      .filter((landing) => landing.entry.kind === "public-first-use")
      .map((landing) => `${landing.site.file}:${landing.line}`);

    const callSites = [];
    const files = execFileSync("git", ["ls-files", "--", "bounded-contexts/auth"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: GIT_LISTING_MAX_BUFFER,
    })
      .trim()
      .split(/\r?\n/)
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(path.join(repoRoot, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const node of walk(source, (node) => ts.isCallExpression(node))) {
        const expression = node.expression;
        const name = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression)
            ? literal(expression.argumentExpression)
            : null;
        if (name === "createPersonalIdentity")
          callSites.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    }

    expect(callSites.length).toBe(7);
    expect(callSites.filter((site) => !registered.has(site))).toEqual([]);
    expect(discovered.sort()).toEqual(callSites.sort());
  });
});

const identityRuntime = "bounded-contexts/identity/support/runtime-support/";
const wholeFileAnchors = new Set(
  ["accounts", "users", "memberships"].flatMap((aggregate) => [
    `identity-domain-deciders:bounded-contexts/identity/features/${aggregate}/domain/domain.ts`,
    `identity-domain-decider-tests:bounded-contexts/identity/features/${aggregate}/domain/domain.test.ts`,
  ]),
);

function walk(node, predicate) {
  const found = [];
  function visit(child) {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  return node;
}

function property(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find((member) => member.name?.getText() === name);
}

function value(object, name) {
  const member = property(object, name);
  return unwrap(member && ts.isPropertyAssignment(member) ? member.initializer : member);
}

function expressionText(node) {
  const expression = unwrap(node);
  return expression && ts.isShorthandPropertyAssignment(expression) ? expression.name.text : expression?.getText();
}

function literal(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function inWorkflow(node, name) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name?.getText() === name)
      return true;
    if (ts.isCallExpression(parent) && parent.expression.getText() === "it" && literal(parent.arguments[0]) === name) {
      return true;
    }
  }
  return false;
}

function inRoute(node, method, route) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      parent.expression.getText() === `app.${method}` &&
      literal(parent.arguments[0]) === route
    )
      return true;
  }
  return false;
}

function registrationEndpoint(node) {
  if (!node) return false;
  if (ts.isNewExpression(node) && node.expression.getText() === "URL") {
    return literal(node.arguments?.[0]) === "/api/auth/register";
  }
  return (
    ts.isTemplateExpression(node) &&
    node.head.text === "" &&
    node.templateSpans.length === 1 &&
    node.templateSpans[0].literal.text === "/api/auth/register"
  );
}

function call(callee, workflow, extra = () => true) {
  return (source) =>
    walk(
      source,
      (node) =>
        ts.isCallExpression(node) && node.expression.getText() === callee && inWorkflow(node, workflow) && extra(node),
    );
}

function command(callee, workflow, type, identity = {}, extra = () => true) {
  return (source) =>
    call(
      callee,
      workflow,
    )(source).flatMap((node) => {
      const object = value(node.arguments[0], "command");
      const discriminator = property(object, "type");
      if (literal(value(object, "type")) !== type || !extra(node)) return [];
      if (!Object.entries(identity).every(([key, expected]) => expressionText(value(object, key)) === expected))
        return [];
      return [discriminator];
    });
}

function seedStep(aggregate, fixture) {
  const names = {
    Account: ["accounts", "CreateAccount", "accountId"],
    User: ["users", "CreateUser", "userId"],
    Membership: ["memberships", "GrantMembership", "membershipId"],
  };
  const [receiver, type, id] = names[aggregate];
  const reconciler = `${aggregate.toLowerCase()}Reconciler`;
  return (source) => {
    // A step is executable only through this reconciler's unchanged dispatch wiring.
    const declarations = walk(
      source,
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText() === reconciler &&
        inWorkflow(node, "buildScenarioIdentityReconcilers"),
    );
    if (declarations.length !== 1) return [];
    const factory = declarations[0].initializer;
    if (!ts.isArrowFunction(factory) || !factory.parameters.some((parameter) => parameter.name.getText() === "steps"))
      return [];
    const builders = walk(
      factory.body,
      (node) => ts.isCallExpression(node) && node.expression.getText() === "createSeedAggregateReconciler",
    );
    if (builders.length !== 1) return [];
    const options = builders[0].arguments[0];
    if (literal(value(options, "aggregateName")) !== aggregate || expressionText(value(options, "steps")) !== "steps")
      return [];
    const send = value(options, "send");
    if (!send || !ts.isArrowFunction(send)) return [];
    const dispatch = walk(
      send.body,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText() === `services.${receiver}.commandHandler` &&
        expressionText(value(node.arguments[0], "command")) === "command",
    );
    if (dispatch.length !== 1) return [];
    return call(
      reconciler,
      "buildScenarioIdentityReconcilers",
      (node) => expressionText(node.arguments[0]) === `${fixture}.${id}`,
    )(source).flatMap((node) => {
      const steps = node.arguments[2];
      if (!steps || !ts.isArrayLiteralExpression(steps)) return [];
      return steps.elements
        .filter(
          (object) =>
            literal(value(object, "type")) === type && expressionText(value(object, id)) === `${fixture}.${id}`,
        )
        .map((object) => property(object, "type"));
    });
  };
}

const personalIdentity = (workflow, method, route) =>
  call("identityMutations.createPersonalIdentity", workflow, (node) => inRoute(node, method, route));
const postOptions = (node) => literal(value(node.arguments[1], "method")) === "POST";
const commandsFor = (workflow, prefix, fixture) =>
  [
    ["accounts", "CreateAccount", "accountId"],
    ["users", "CreateUser", "userId"],
    ["memberships", "GrantMembership", "membershipId"],
  ].map(([receiver, type, id]) =>
    command(`${prefix}.${receiver}.commandHandler`, workflow, type, { [id]: fixture ? `${fixture}.${id}` : id }),
  );

// Slot meaning comes from the introduction history. Each registry site names its
// landing by workflow symbol and content; its line is computed, never pinned.
const landingSelectors = {
  "password-direct-registration": [personalIdentity("registerRegistrationRoutes", "post", "/register")],
  "invitation-registration": [
    personalIdentity("registerInvitationRoutes", "post", "/invitations/accept"),
    call("identity.createPersonalIdentity", "acceptInvitationAttempt"),
  ],
  "first-use-magic-link": [personalIdentity("registerMagicLinkRoutes", "post", "/magic-link/consume")],
  "passkey-registration": [personalIdentity("registerPasskeyRoutes", "post", "/passkeys/register")],
  "phone-code-registration": [personalIdentity("registerPhoneCodeRoutes", "post", "/phone-code/consume")],
  "social-login-first-use": [personalIdentity("registerSocialLoginRoutes", "get", "/social/:provider/callback")],
  "marketplace-register-route-action": [call("api.register", "createRegisterAction")],
  "marketplace-e2e-auth-helper": [
    call("fetch", "registerSyntheticAccount", (node) => registrationEndpoint(node.arguments[0]) && postOptions(node)),
  ],
  "guest-buy-now-freshness-probe": [
    call("page.request.post", "registerSyntheticAccountSession", (node) => registrationEndpoint(node.arguments[0])),
  ],
  "stripe-money-smoke-test": [
    call(
      "requestJson",
      "registerSellerAccount",
      (node) => registrationEndpoint(node.arguments[0]) && postOptions(node),
    ),
  ],
  "protected-account-administration": [
    command("services.commandHandler", "accountRoutes", "CreateAccount", { accountId: "accountId" }, (node) =>
      inRoute(node, "post", "/"),
    ),
  ],
  "protected-user-administration": [
    command("services.commandHandler", "userRoutes", "CreateUser", { userId: "userId" }, (node) =>
      inRoute(node, "post", "/"),
    ),
  ],
  "protected-membership-administration": [
    command(
      "services.commandHandler",
      "membershipRoutes",
      "GrantMembership",
      { membershipId: "membershipId" },
      (node) => inRoute(node, "post", "/"),
    ),
  ],
  "platform-api-bootstrap-reconciliation-db-test": [
    command(
      "identityServices.accounts.commandHandler",
      "appendRepresentativeAccountCreatedEvent",
      "CreateAccount",
      {},
      (node) => expressionText(value(node.arguments[0], "streamId")) === "`identity.account-${profile.accountId}`",
    ),
    command(
      "identityServices.users.commandHandler",
      "proves the reviewed projection guard fails at User, then resumes a full retained Identity seed",
      "CreateUser",
      { userId: "retainedRepresentativeAccount.userId" },
    ),
  ],
  "production-platform-admin-bootstrap": commandsFor("bootstrapPlatformAdminIdentity", "services"),
  "admin-qa-actor-fixtures": commandsFor("provisionAdminQaActorFixture", "services", "fixture"),
  "development-scenario-seed": [
    ...["Account", "User", "Membership"].flatMap((aggregate) =>
      ["demo", "collector", "support", "suspended", "persona.seed"].map((fixture) => seedStep(aggregate, fixture)),
    ),
    ...["Account", "User", "Membership"].map((aggregate) => {
      const [receiver, type, id] = {
        Account: ["accounts", "CreateAccount", "accountId"],
        User: ["users", "CreateUser", "userId"],
        Membership: ["memberships", "GrantMembership", "membershipId"],
      }[aggregate];
      return command(`services.${receiver}.commandHandler`, `reconcileRepresentative${aggregate}`, type, {
        [id]: `account.${id}`,
      });
    }),
  ],
  "guest-checkout-account-claim": [
    call("identityMutations.createGuestAccount", "registerGuestCheckoutRoutes", (node) =>
      inRoute(node, "post", "/guest-checkout/start"),
    ),
    call("identityMutations.createUser", "resolveClaimUser"),
    call("identityMutations.claimGuestAccount", "claimGuestAccountAndStartSession"),
  ],
};

// Each in-memory replacement must match exactly once, so a control can never
// pass because its anchor drifted out of the real source.
function parseMutant(file, text, replacements) {
  const mutated = replacements.reduce((current, [pattern, replacement]) => {
    const matches =
      typeof pattern === "string"
        ? current.split(pattern).length - 1
        : (current.match(new RegExp(pattern.source, "g")) ?? []).length;
    if (matches !== 1) throw new Error(`${file}: expected one ${pattern} anchor, found ${matches}`);
    return current.replace(pattern, replacement);
  }, text);
  return ts.createSourceFile(file, mutated, ts.ScriptTarget.Latest, true);
}

// The register form renders no affirmation control yet, so the route action
// must hand Identity exactly the resolution it just fetched, unaffirmed.
function collectMarketplaceSubmissionViolations(source) {
  const registers = call("api.register", "createRegisterAction")(source);
  if (registers.length !== 1) return [`expected one api.register call, found ${registers.length}`];
  const submission = value(registers[0].arguments[0], "registrationConsent");
  if (!submission || !ts.isObjectLiteralExpression(submission)) {
    return ["api.register must forward a registrationConsent object"];
  }
  const members = submission.properties.map((member) => member.name?.getText()).toSorted();
  const resolution = value(submission, "resolution");
  const fetched =
    resolution &&
    ts.isAwaitExpression(resolution) &&
    ts.isCallExpression(resolution.expression) &&
    resolution.expression.expression.getText() === "api.getRegistrationConsent" &&
    resolution.expression.arguments.length === 0;
  return [
    ...(members.join() === "affirmed,resolution"
      ? []
      : [`registrationConsent must carry only resolution and affirmed, found ${members.join(", ")}`]),
    ...(fetched ? [] : ["resolution must be the awaited api.getRegistrationConsent() result"]),
    ...(value(submission, "affirmed")?.kind === ts.SyntaxKind.FalseKeyword ? [] : ["affirmed must be false"]),
  ];
}

const registrationConsentOperations = new Set([
  "getRegistrationConsent",
  "resolveRegistrationConsent",
  "resolveUnaffirmedRegistrationConsent",
  "createPersonalIdentity",
]);

// Every call that reaches the registration consent mint or personal-identity
// creation, followed through import and destructuring aliases, and every
// Registration Consent Submission handed over by property name.
function collectRegistrationConsentReferences(source) {
  const names = new Set(registrationConsentOperations);
  for (const alias of walk(source, (node) => ts.isImportSpecifier(node) || ts.isBindingElement(node))) {
    if (registrationConsentOperations.has((alias.propertyName ?? alias.name).getText()))
      names.add(alias.name.getText());
  }
  const operation = (expression) =>
    ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isElementAccessExpression(expression)
        ? literal(expression.argumentExpression)
        : expression.getText();
  return walk(
    source,
    (node) =>
      (ts.isCallExpression(node) && names.has(operation(node.expression))) ||
      ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText() === "registrationConsent"),
  ).map(
    (node) =>
      `${referenceOwner(node)}: ${ts.isCallExpression(node) ? `call ${node.expression.getText()}` : "property registrationConsent"}`,
  );
}

function referenceOwner(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const route = ts.isCallExpression(parent) && /^app\.(get|post)$/.test(parent.expression.getText());
    if (route && literal(parent.arguments[0])) {
      return `${parent.expression.name.text.toUpperCase()} ${literal(parent.arguments[0])}`;
    }
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
  }
  return "<module>";
}

function registrySlots(candidate) {
  return [...candidate.paths, ...candidate.compositions].flatMap((entry) =>
    (entry.sites ?? entry.members).map((site, index) => ({ entry, site, index, label: `${entry.id}[${index}]` })),
  );
}

function parseRegisteredSources(candidate) {
  return new Map(
    [...new Set(registrySlots(candidate).map(({ site }) => site.file))].map((file) => [
      file,
      ts.createSourceFile(file, readFileSync(path.join(repoRoot, file), "utf8"), ts.ScriptTarget.Latest, true),
    ]),
  );
}

const selectorCache = new WeakMap();

function selectTargets(source, selector) {
  if (!selectorCache.has(source)) selectorCache.set(source, new Map());
  const cached = selectorCache.get(source);
  if (!cached.has(selector)) cached.set(selector, selector(source));
  return cached.get(selector);
}

const identityKeys = ["symbol", "content"];
const aggregateIds = { CreateAccount: "accountId", CreateUser: "userId", GrantMembership: "membershipId" };

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

// The enclosing workflows, outermost first, named as inWorkflow matches them.
function workflowSymbol(node) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name)
      names.unshift(parent.name.getText());
    if (ts.isCallExpression(parent) && parent.expression.getText() === "it" && literal(parent.arguments[0]))
      names.unshift(literal(parent.arguments[0]));
  }
  return names.join(" > ");
}

function landingContent(target) {
  if (!ts.isPropertyAssignment(target)) return target.expression.getText();
  const type = literal(target.initializer);
  const id = expressionText(value(target.parent, aggregateIds[type]));
  return id ? `${type} ${id}` : type;
}

function siteText(site) {
  return identityKeys.some((key) => Object.hasOwn(site, key))
    ? `${site.file} [${site.symbol}] ${site.content}`
    : site.file;
}

function malformedSite({ entry, site }, wholeFile) {
  const allowed = ["file", ...identityKeys, ...(entry.members ? ["constructor"] : [])];
  const unknown = Object.keys(site).filter((key) => !allowed.includes(key));
  if (unknown.length) return `malformed site: unknown member ${unknown.join(", ")}`;
  if (wholeFile)
    return identityKeys.some((key) => Object.hasOwn(site, key))
      ? "malformed site: a whole-file anchor names no symbol or content"
      : undefined;
  return identityKeys.every((key) => typeof site[key] === "string" && site[key].trim())
    ? undefined
    : "malformed site: expected a symbol and content";
}

function discoverLandingTargets(candidate, sources) {
  return registrySlots(candidate).map((slot) => {
    const source = sources.get(slot.site.file);
    if (!source || source.parseDiagnostics.length) return { ...slot, error: "missing or unparseable source" };
    const wholeFile = wholeFileAnchors.has(`${slot.entry.id}:${slot.site.file}`);
    const selector =
      !wholeFile && Object.hasOwn(landingSelectors, slot.entry.id) && landingSelectors[slot.entry.id][slot.index];
    if (!wholeFile && !selector) return { ...slot, error: "unclassified slot" };
    const malformed = malformedSite(slot, wholeFile);
    if (malformed) return { ...slot, error: malformed };
    if (wholeFile) return { ...slot, line: 1, wholeFile: true };
    const targets = selectTargets(source, selector);
    if (targets.length !== 1) {
      const lines = targets.map((target) => lineOf(source, target)).join(", ");
      return { ...slot, error: `expected one executable target, found ${targets.length}${lines && ` at ${lines}`}` };
    }
    const target = targets[0];
    return {
      ...slot,
      target,
      line: lineOf(source, target),
      symbol: workflowSymbol(target),
      content: landingContent(target),
      operation: ts.isPropertyAssignment(target) ? literal(target.initializer) : target.expression.getText(),
    };
  });
}

function collectDuplicateLandings(landings) {
  return [
    ...[...Map.groupBy(landings, (landing) => siteText(landing.site))].map(([identity, group]) => [
      group,
      `duplicate site identity ${identity}`,
    ]),
    ...[
      ...Map.groupBy(
        landings.filter((landing) => landing.target),
        (landing) => landing.target,
      ).values(),
    ].map((group) => [group, `duplicate creation landing at line ${group[0].line}`]),
  ]
    .filter(([group]) => group.length > 1)
    .map(([group, error]) => `${group.map(({ label }) => label).join(", ")}: ${error}`);
}

function collectUnclaimedSlots(candidate) {
  const labels = new Set(registrySlots(candidate).map(({ label }) => label));
  const anchors = new Set(registrySlots(candidate).map(({ entry, site }) => `${entry.id}:${site.file}`));
  return [
    ...Object.entries(landingSelectors)
      .flatMap(([id, selectors]) => selectors.map((_, index) => `${id}[${index}]`))
      .filter((label) => !labels.has(label))
      .map((label) => `${label}: selector has no registry site`),
    ...[...wholeFileAnchors]
      .filter((anchor) => !anchors.has(anchor))
      .map((anchor) => `${anchor}: whole-file anchor has no registry site`),
  ];
}

function collectPinLandingViolations(candidate, sources) {
  const landings = discoverLandingTargets(candidate, sources);
  return [
    ...landings.flatMap((landing) => {
      const { label, site } = landing;
      if (landing.error) return [`${label} ${siteText(site)}: ${landing.error}`];
      if (site.symbol !== landing.symbol || site.content !== landing.content)
        return [
          `${label} ${siteText(site)}: expected creation landing [${landing.symbol}] ${landing.content} at line ${landing.line}`,
        ];
      return [];
    }),
    ...collectDuplicateLandings(landings),
    ...collectUnclaimedSlots(candidate),
  ];
}

function withSite(candidate, slot, changes) {
  const changed = structuredClone(candidate);
  Object.assign(registrySlots(changed).find(({ label }) => label === slot.label).site, changes);
  return changed;
}

function schemaPointer(candidate, slot) {
  const pathIndex = candidate.paths.indexOf(slot.entry);
  return pathIndex >= 0
    ? `<root>/paths[${pathIndex}]/sites[${slot.index}]`
    : `<root>/compositions[${candidate.compositions.indexOf(slot.entry)}]/members[${slot.index}]`;
}

describe("identity creation pin landing", () => {
  it("every registry pin lands on its creation call", () => {
    const sources = registeredSources;
    const landings = discoverLandingTargets(registry, sources);
    expect(landings).toHaveLength(49);
    expect(landings.filter((landing) => landing.wholeFile)).toHaveLength(6);
    expect(collectPinLandingViolations(registry, sources)).toEqual([]);
    for (const slot of landings) {
      if (slot.wholeFile) {
        const named = { symbol: "domain", content: "CreateAccount" };
        expect(collectPinLandingViolations(withSite(registry, slot, named), sources), slot.label).toEqual([
          `${slot.label} ${siteText({ ...slot.site, ...named })}: malformed site: a whole-file anchor names no symbol or content`,
        ]);
        continue;
      }
      for (const stale of [{ symbol: `${slot.symbol} (stale)` }, { content: `${slot.content} (stale)` }]) {
        const errors = collectPinLandingViolations(withSite(registry, slot, stale), sources);
        expect(errors, `${slot.label} must reject ${JSON.stringify(stale)}`).toEqual([
          `${slot.label} ${siteText({ ...slot.site, ...stale })}: expected creation landing [${slot.symbol}] ${slot.content} at line ${slot.line}`,
        ]);
      }
      const otherFixture = landings.find(
        (other) =>
          other.site.file === slot.site.file &&
          other.line !== slot.line &&
          other.operation === slot.operation &&
          !other.wholeFile,
      );
      if (otherFixture) {
        const borrowed = { symbol: otherFixture.symbol, content: otherFixture.content };
        const pair = [slot, otherFixture].sort((left, right) => landings.indexOf(left) - landings.indexOf(right));
        expect(collectPinLandingViolations(withSite(registry, slot, borrowed), sources), slot.label).toEqual([
          `${slot.label} ${siteText({ ...slot.site, ...borrowed })}: expected creation landing [${slot.symbol}] ${slot.content} at line ${slot.line}`,
          `${pair.map(({ label }) => label).join(", ")}: duplicate site identity ${siteText(otherFixture.site)}`,
        ]);
      }
    }
  });

  it("rejects any numeric line authority, even one naming the current landing", () => {
    const sources = registeredSources;
    for (const slot of discoverLandingTargets(registry, sources)) {
      const pinned = withSite(registry, slot, { line: slot.line });
      expect(validateAgainstSchema(pinned, schema), slot.label).toEqual([
        `${schemaPointer(registry, slot)}: unknown member "line"`,
      ]);
      expect(collectPinLandingViolations(pinned, sources), slot.label).toEqual([
        `${slot.label} ${siteText(slot.site)}: malformed site: unknown member line`,
      ]);
    }
  });

  it("landing-check-bypass control rejects stale identities with unchanged source", () => {
    const sources = registeredSources;
    expect(collectPinLandingViolations(registry, sources)).toEqual([]);
    function assertStaleIdentityRejected(validate) {
      for (const slot of discoverLandingTargets(registry, sources).filter((landing) => !landing.wholeFile)) {
        const errors = validate(withSite(registry, slot, { symbol: `${slot.symbol} (stale)` }), sources);
        expect(errors, `${slot.label} stale identity must fail`).toHaveLength(1);
        expect(errors[0]).toContain(`${slot.label} ${slot.site.file} `);
      }
    }
    assertStaleIdentityRejected(collectPinLandingViolations);

    const validatorSource = collectPinLandingViolations.toString();
    const comparison = /site\.symbol\s*!==\s*landing\.symbol\s*\|\|\s*site\.content\s*!==\s*landing\.content/g;
    expect(validatorSource.match(comparison)).toHaveLength(1);
    const helpers = { discoverLandingTargets, siteText, collectDuplicateLandings, collectUnclaimedSlots };
    const mutant = compileFunction(`return (${validatorSource.replace(comparison, "false")})(candidate, sources);`, [
      "candidate",
      "sources",
      ...Object.keys(helpers),
    ]);
    const bypassedValidator = (candidate, fixedSources) => mutant(candidate, fixedSources, ...Object.values(helpers));
    expect(bypassedValidator(registry, sources)).toEqual([]);
    expect(() => assertStaleIdentityRejected(bypassedValidator)).toThrow(
      "password-direct-registration[0] stale identity must fail",
    );
  });

  it("rejects executable lookalikes, comments and strings without changing the other pins", () => {
    const sources = registeredSources;
    const landings = discoverLandingTargets(registry, sources);
    // Synthetic source stays out of the separate tracked command-position census.
    const accountType = ["type", ': "CreateAccount"'].join("");
    const controls = [
      [
        "password-direct-registration",
        [
          "// identityMutations.createPersonalIdentity({});",
          'const misleading = "identityMutations.createPersonalIdentity({})";',
          "function registerRegistrationRoutesLookalike() { other.createPersonalIdentity({}); }",
          "function unrelatedWorkflow() { identityMutations.createPersonalIdentity({}); }",
        ],
      ],
      [
        "marketplace-e2e-auth-helper",
        [
          'function registerSyntheticAccount() { other.fetch(new URL("/api/auth/register", origin), { method: "POST" }); }',
          'function registerSyntheticAccount() { fetch(new URL("/api/auth/registration-consent", origin), { method: "POST" }); }',
          'function registerSyntheticAccount() { fetch(new URL("/api/auth/register", origin), { method: "GET" }); }',
        ],
      ],
      [
        "guest-buy-now-freshness-probe",
        [
          "function registerSyntheticAccountSession() { other.post(`${baseUrl}/api/auth/register`, {}); }",
          "function registerSyntheticAccountSession() { page.request.get(`${baseUrl}/api/auth/register`, {}); }",
        ],
      ],
      [
        "stripe-money-smoke-test",
        [
          'function registerSellerAccount() { requestJson(`${baseUrl}/api/auth/registration-consent`, { method: "POST" }); }',
          'function registerSellerAccount() { requestJson(`${baseUrl}/api/auth/register`, { method: "GET" }); }',
        ],
      ],
      [
        "marketplace-register-route-action",
        ["function createRegisterAction() { other.register<InteractiveAuthResult>({}); }"],
      ],
      [
        "development-scenario-seed",
        [
          `// ${accountType}, accountId: demo.accountId`,
          `const misleadingCommand = '${accountType}, accountId: demo.accountId';`,
          `function buildScenarioIdentityReconcilers() { other.commandHandler({ command: { ${accountType}, accountId: demo.accountId } }); }`,
          `function buildScenarioIdentityReconcilers() { accountReconciler(otherFixture.accountId, "wrong fixture", [{ ${accountType}, accountId: otherFixture.accountId }]); }`,
        ],
      ],
    ];
    for (const [id, decoys] of controls) {
      const slot = landings.find(({ entry }) => entry.id === id);
      const source = sources.get(slot.site.file);
      const withDecoys = (text) =>
        new Map(sources).set(
          slot.site.file,
          ts.createSourceFile(slot.site.file, `${text}\n${decoys.join("\n")}\n`, ts.ScriptTarget.Latest, true),
        );
      const decoyed = withDecoys(source.text);
      expect(collectPinLandingViolations(registry, decoyed), `${id} control baseline`).toEqual([]);
      expect(
        discoverLandingTargets(registry, decoyed).map(({ line }) => line),
        `${id} decoys move no landing`,
      ).toEqual(landings.map(({ line }) => line));
      // With the real creation removed, the decoys alone must not satisfy the slot.
      const neutral = ts.isPropertyAssignment(slot.target) ? "unrelated: 0" : "(void 0)";
      const removed = withDecoys(
        `${source.text.slice(0, slot.target.getStart(source))}${neutral}${source.text.slice(slot.target.end)}`,
      );
      expect(collectPinLandingViolations(registry, removed), `${id} decoys alone`).toEqual([
        `${slot.label} ${siteText(slot.site)}: expected one executable target, found 0`,
      ]);
    }
  });

  it("rejects a restored Consent-only slot", () => {
    const sources = registeredSources;
    for (const [id, symbol] of [
      ["admin-qa-actor-fixtures", "provisionAdminQaActorFixture"],
      ["development-scenario-seed", "buildScenarioIdentityReconcilers"],
      ["development-scenario-seed", "reconcileRepresentativeConsent"],
    ]) {
      const restored = structuredClone(registry);
      const entry = restored.paths.find((candidate) => candidate.id === id);
      const site = { file: entry.sites[0].file, symbol, content: "services.consents.commandHandler" };
      entry.sites.push(site);
      expect(collectPinLandingViolations(restored, sources), `${id} restored Consent slot`).toEqual([
        `${id}[${entry.sites.length - 1}] ${siteText(site)}: unclassified slot`,
      ]);
    }
  });

  it("fails closed on unknown, duplicate, incomplete and malformed slots and altered whole-file exceptions", () => {
    const sources = registeredSources;
    const unknown = structuredClone(registry);
    unknown.paths[0].id = "unclassified-creation-path";
    expect(collectPinLandingViolations(unknown, sources)[0]).toContain("unclassified slot");
    const extra = structuredClone(registry);
    extra.paths[0].sites.push({ ...extra.paths[0].sites[0] });
    expect(collectPinLandingViolations(extra, sources)).toEqual([
      `password-direct-registration[1] ${siteText(registry.paths[0].sites[0])}: unclassified slot`,
      `password-direct-registration[0], password-direct-registration[1]: duplicate site identity ${siteText(registry.paths[0].sites[0])}`,
    ]);
    const changed = structuredClone(registry);
    changed.paths.find((entry) => entry.id === "identity-domain-deciders").sites[0].file = `${identityRuntime}seed.ts`;
    expect(collectPinLandingViolations(changed, sources)[0]).toContain("unclassified slot");

    const deciders = (candidate) => candidate.paths.find((entry) => entry.id === "identity-domain-deciders");
    const duplicatedAnchor = structuredClone(registry);
    deciders(duplicatedAnchor).sites.push({ ...deciders(registry).sites[0] });
    expect(collectPinLandingViolations(duplicatedAnchor, sources)).toEqual([
      `identity-domain-deciders[0], identity-domain-deciders[3]: duplicate site identity ${deciders(registry).sites[0].file}`,
    ]);
    const missingAnchor = structuredClone(registry);
    const [removedAnchor] = deciders(missingAnchor).sites.splice(2, 1);
    expect(collectPinLandingViolations(missingAnchor, sources)).toEqual([
      `identity-domain-deciders:${removedAnchor.file}: whole-file anchor has no registry site`,
    ]);

    const incomplete = structuredClone(registry);
    incomplete.paths.find((entry) => entry.id === "development-scenario-seed").sites.pop();
    expect(collectPinLandingViolations(incomplete, sources)).toEqual([
      "development-scenario-seed[17]: selector has no registry site",
    ]);

    const [first] = registrySlots(registry);
    for (const [changes, error] of [
      [{ content: undefined }, "expected a symbol and content"],
      [{ symbol: "  " }, "expected a symbol and content"],
      [{ content: 53 }, "expected a symbol and content"],
    ]) {
      const malformed = withSite(registry, first, changes);
      const site = registrySlots(malformed)[0].site;
      expect(collectPinLandingViolations(malformed, sources), JSON.stringify(changes)).toEqual([
        `${first.label} ${siteText(site)}: malformed site: ${error}`,
      ]);
    }

    const landings = discoverLandingTargets(registry, sources);
    const [target] = landings;
    const alias = { ...target, label: "alias[0]", site: { ...target.site, symbol: "alias" } };
    expect(collectDuplicateLandings([...landings, alias])).toEqual([
      `${target.label}, alias[0]: duplicate creation landing at line ${target.line}`,
    ]);
  });

  it("derives moved targets from source and rejects detached seed dispatch wiring", () => {
    const sources = registeredSources;
    const landings = discoverLandingTargets(registry, sources);
    for (const [file, source] of sources) {
      // Insert below a shebang, which must stay the first line.
      const at = source.text.startsWith("#!") ? source.text.indexOf("\n") + 1 : 0;
      const moved = `${source.text.slice(0, at)}// unrelated moved line\n${source.text.slice(at)}`;
      const shifted = new Map(sources).set(file, ts.createSourceFile(file, moved, ts.ScriptTarget.Latest, true));
      expect(collectPinLandingViolations(registry, shifted), file).toEqual([]);
      expect(
        discoverLandingTargets(registry, shifted).map(({ line, site, wholeFile }) =>
          site.file === file && !wholeFile ? line - 1 : line,
        ),
        file,
      ).toEqual(landings.map(({ line }) => line));
    }
    const file = `${identityRuntime}seed.ts`;
    const source = sources.get(file);
    expect(source.text).not.toContain("services.consents.commandHandler");
    for (const receiver of ["accounts", "users", "memberships"]) {
      const detached = new Map(sources);
      const text = source.text.replace(`services.${receiver}.commandHandler`, `unrelated.${receiver}.commandHandler`);
      expect(text).not.toBe(source.text);
      detached.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
      const errors = collectPinLandingViolations(registry, detached);
      expect(errors).toHaveLength(5);
      expect(errors.every((error) => error.includes("development-scenario-seed[") && error.includes("found 0"))).toBe(
        true,
      );
    }
  });
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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

  it("registers guest checkout as one pinned composition exemption", () => {
    const guestCheckout = registry.compositions.find((entry) => entry.id === "guest-checkout-account-claim");
    expect(guestCheckout, "guest checkout must be classified, not omitted").toBeTruthy();
    expect(guestCheckout.disposition).toBe("exempt-temporary");
    expect(guestCheckout.members.map((member) => member.constructor).sort()).toEqual([
      "claimGuestAccount",
      "createGuestAccount",
      "createUser",
    ]);
    for (const member of guestCheckout.members) {
      const lines = readSite(member);
      expect(lines, `${member.file} must exist`).toBeTruthy();
      expect(lines[member.line - 1], `${member.file}:${member.line}`).toContain(member.constructor);
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
    const authRoutesDirectory = path.join(repoRoot, "bounded-contexts/auth/support/api-support");
    const registered = new Set(
      registry.paths.flatMap((entry) => entry.sites.map((site) => `${site.file}:${site.line}`)),
    );

    const discovered = [];
    for (const entry of registry.paths.filter((path) => path.kind === "public-first-use")) {
      for (const site of entry.sites) {
        discovered.push(`${site.file}:${site.line}`);
      }
    }

    // Independent rediscovery: every createPersonalIdentity call in the Auth
    // API surface must already be a registered site. A new caller shows up here
    // as an unregistered position rather than as a silently bound one.
    const callSites = [];
    for (const file of [
      "invitation-routes",
      "magic-link-routes",
      "passkey-routes",
      "phone-code-routes",
      "register-routes",
      "social-login-routes",
      "guest-checkout-routes",
    ]) {
      const relative = `bounded-contexts/auth/support/api-support/${file}.ts`;
      const lines = readFileSync(path.join(authRoutesDirectory, `${file}.ts`), "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes("await identityMutations.createPersonalIdentity(")) {
          callSites.push(`${relative}:${index + 1}`);
        }
      });
    }

    expect(callSites.length).toBe(6);
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
    Consent: ["consents", "RecordConsent", "consentId"],
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
      const steps = node.arguments[aggregate === "Consent" ? 4 : 2];
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

// Slot meaning comes from the introduction history, never from the current numeric pin.
const landingSelectors = {
  "password-direct-registration": [personalIdentity("registerRegistrationRoutes", "post", "/register")],
  "invitation-registration": [personalIdentity("registerInvitationRoutes", "post", "/invitations/accept")],
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
  "admin-qa-actor-fixtures": [
    ...commandsFor("provisionAdminQaActorFixture", "services", "fixture"),
    command("services.consents.commandHandler", "provisionAdminQaActorFixture", "RecordConsent", {
      consentId: "fixture.consentId",
    }),
  ],
  "development-scenario-seed": [
    ...["Account", "User", "Membership"].flatMap((aggregate) =>
      ["demo", "collector", "support", "suspended", "persona.seed"].map((fixture) => seedStep(aggregate, fixture)),
    ),
    seedStep("Consent", "consent"),
    ...["Account", "User", "Membership", "Consent"].map((aggregate) => {
      const [receiver, type, id] = {
        Account: ["accounts", "CreateAccount", "accountId"],
        User: ["users", "CreateUser", "userId"],
        Membership: ["memberships", "GrantMembership", "membershipId"],
        Consent: ["consents", "RecordConsent", "consentId"],
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

function discoverLandingTargets(candidate, sources) {
  return registrySlots(candidate).map((slot) => {
    const source = sources.get(slot.site.file);
    if (!source || source.parseDiagnostics.length) return { ...slot, error: "missing or unparseable source" };
    if (wholeFileAnchors.has(`${slot.entry.id}:${slot.site.file}`)) return { ...slot, line: 1, wholeFile: true };
    const selector = Object.hasOwn(landingSelectors, slot.entry.id) && landingSelectors[slot.entry.id][slot.index];
    if (!selector) return { ...slot, error: "unclassified slot" };
    const targets = selectTargets(source, selector);
    if (targets.length !== 1) return { ...slot, error: `expected one executable target, found ${targets.length}` };
    const target = targets[0];
    return {
      ...slot,
      line: source.getLineAndCharacterOfPosition(target.getStart(source)).line + 1,
      operation: ts.isPropertyAssignment(target) ? literal(target.initializer) : target.expression.getText(),
    };
  });
}

function collectPinLandingViolations(candidate, sources) {
  return discoverLandingTargets(candidate, sources).flatMap((landing) => {
    const { label, site } = landing;
    if (landing.error) return [`${label} ${site.file}:${site.line}: ${landing.error}`];
    if (site.line !== landing.line)
      return [`${label} ${site.file}:${site.line}: expected creation landing at ${landing.line}`];
    return [];
  });
}

function movePin(candidate, slot, line) {
  const moved = structuredClone(candidate);
  registrySlots(moved).find(({ label }) => label === slot.label).site.line = line;
  return moved;
}

describe("identity creation pin landing", () => {
  it("every registry pin lands on its creation call", () => {
    const sources = parseRegisteredSources(registry);
    const landings = discoverLandingTargets(registry, sources);
    expect(landings).toHaveLength(51);
    expect(landings.filter((landing) => landing.wholeFile)).toHaveLength(6);
    expect(collectPinLandingViolations(registry, sources)).toEqual([]);
    for (const slot of landings) {
      for (const line of slot.wholeFile ? [2] : [slot.line + 1, 1]) {
        const errors = collectPinLandingViolations(movePin(registry, slot, line), sources);
        expect(errors, `${slot.label} must reject line ${line}`).toEqual([
          `${slot.label} ${slot.site.file}:${line}: expected creation landing at ${slot.line}`,
        ]);
      }
      const otherFixture = landings.find(
        (other) =>
          other.site.file === slot.site.file &&
          other.line !== slot.line &&
          other.operation === slot.operation &&
          !other.wholeFile,
      );
      if (otherFixture)
        expect(
          collectPinLandingViolations(movePin(registry, slot, otherFixture.line), sources),
          slot.label,
        ).toHaveLength(1);
    }
  });

  it("landing-check-bypass control rejects historical drift with unchanged source", () => {
    const sources = parseRegisteredSources(registry);
    const oldLines = {
      "marketplace-e2e-auth-helper": [92],
      "guest-buy-now-freshness-probe": [1323],
      "platform-api-bootstrap-reconciliation-db-test": [182, 903],
      "admin-qa-actor-fixtures": [188, 203, 233, 249],
      "development-scenario-seed": [
        272, 283, 294, 305, 322, 385, 455, 484, 524, 542, 572, 584, 596, 627, 640, 655, 844, 895, 944, 983,
      ],
    };
    expect(collectPinLandingViolations(registry, sources)).toEqual([]);
    for (const slot of registrySlots(registry).filter(({ entry }) => Object.hasOwn(oldLines, entry.id))) {
      const errors = collectPinLandingViolations(movePin(registry, slot, oldLines[slot.entry.id][slot.index]), sources);
      expect(errors, `${slot.label} historical main drift must fail`).toHaveLength(1);
      expect(errors[0]).toContain(`${slot.label} ${slot.site.file}:`);
    }
  });

  it("rejects executable lookalikes, comments and strings without changing the other pins", () => {
    const sources = parseRegisteredSources(registry);
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
      const slot = registrySlots(registry).find(({ entry }) => entry.id === id);
      const source = sources.get(slot.site.file);
      const text = `${source.text}\n${decoys.join("\n")}\n`;
      const fixedSources = new Map(sources);
      fixedSources.set(slot.site.file, ts.createSourceFile(slot.site.file, text, ts.ScriptTarget.Latest, true));
      expect(collectPinLandingViolations(registry, fixedSources), `${id} control baseline`).toEqual([]);
      const firstDecoyLine = source.text.split("\n").length + 1;
      decoys.forEach((_, index) => {
        expect(
          collectPinLandingViolations(movePin(registry, slot, firstDecoyLine + index), fixedSources),
          `${id} decoy ${index}`,
        ).toHaveLength(1);
      });
    }
  });

  it("fails closed on unknown slots and altered whole-file exceptions", () => {
    const sources = parseRegisteredSources(registry);
    const unknown = structuredClone(registry);
    unknown.paths[0].id = "unclassified-creation-path";
    expect(collectPinLandingViolations(unknown, sources)[0]).toContain("unclassified slot");
    const extra = structuredClone(registry);
    extra.paths[0].sites.push({ ...extra.paths[0].sites[0] });
    expect(collectPinLandingViolations(extra, sources)[0]).toContain("password-direct-registration[1]");
    const changed = structuredClone(registry);
    changed.paths.find((entry) => entry.id === "identity-domain-deciders").sites[0].file = `${identityRuntime}seed.ts`;
    expect(collectPinLandingViolations(changed, sources)[0]).toContain("unclassified slot");
  });

  it("derives shifted targets from source and rejects detached seed dispatch wiring", () => {
    const sources = parseRegisteredSources(registry);
    const file = `${identityRuntime}seed.ts`;
    const source = sources.get(file);
    const shifted = new Map(sources);
    shifted.set(file, ts.createSourceFile(file, `\n${source.text}`, ts.ScriptTarget.Latest, true));
    const moved = structuredClone(registry);
    for (const { site } of registrySlots(moved).filter(({ site }) => site.file === file)) site.line += 1;
    expect(collectPinLandingViolations(moved, shifted)).toEqual([]);
    expect(collectPinLandingViolations(registry, shifted)).toHaveLength(20);
    for (const receiver of ["accounts", "users", "memberships", "consents"]) {
      const detached = new Map(sources);
      const text = source.text.replace(`services.${receiver}.commandHandler`, `unrelated.${receiver}.commandHandler`);
      expect(text).not.toBe(source.text);
      detached.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
      const errors = collectPinLandingViolations(registry, detached);
      expect(errors).toHaveLength(receiver === "consents" ? 1 : 5);
      expect(errors.every((error) => error.includes("development-scenario-seed[") && error.includes("found 0"))).toBe(
        true,
      );
    }
  });
});

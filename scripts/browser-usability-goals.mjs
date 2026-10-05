import guest from "./browser-usability-goals/guest.mjs";
import buyer from "./browser-usability-goals/buyer.mjs";
import seller from "./browser-usability-goals/seller.mjs";
import operatorCatalog from "./browser-usability-goals/operator-catalog.mjs";
import operatorWorkspaces from "./browser-usability-goals/operator-workspaces.mjs";

export const browserUsabilityGoalModules = [guest, buyer, seller, operatorCatalog, operatorWorkspaces];

export function validateBrowserUsabilityGoalModules(modules) {
  const ids = new Set();
  const claimed = new Set();
  const excluded = new Set();
  for (const surface of modules) {
    const scope = surface.routeScope.map((pattern) => new RegExp(pattern));
    const inScope = (file) => scope.some((pattern) => pattern.test(file));
    for (const goal of surface.goals) {
      const fail = (message) => {
        throw new Error(`${surface.id}/${goal.id}: ${message}`);
      };
      if (ids.has(goal.id)) fail("Duplicate goal id.");
      ids.add(goal.id);
      if (!["guest", "buyer", "seller", "operator"].includes(goal.role)) fail("Invalid role.");
      if (!["marketplace", "public-web", "admin-web"].includes(goal.host)) fail("Invalid host.");
      for (const check of goal.checks) {
        if (typeof goal.oracle?.[check] !== "string" || !goal.oracle[check].trim())
          fail(`Missing oracle for check: ${check}.`);
      }
      for (const check of Object.keys(goal.oracle ?? {})) {
        if (!goal.checks.includes(check)) fail(`Extra oracle key: ${check}.`);
      }
      for (const [file, check] of Object.entries(goal.routes ?? {})) {
        if (!inScope(file)) fail(`Route outside scope: ${file}.`);
        if (!goal.checks.includes(check)) fail(`Route maps to unknown check: ${file}.`);
        claimed.add(file);
      }
      if (
        !Array.isArray(goal.paths) ||
        !goal.paths.length ||
        goal.paths.some((prefix) => typeof prefix !== "string" || !prefix.trim())
      )
        fail("Paths must be non-empty.");
      if (goal.startSignedIn !== undefined && typeof goal.startSignedIn !== "boolean")
        fail("startSignedIn must be a boolean.");
      if (/\/[a-z]/i.test(goal.goal)) fail("Goal text contains a URL path token.");
    }
    for (const exclusion of surface.excludedRoutes) {
      if (!inScope(exclusion.path)) throw new Error(`${surface.id}: Exclusion outside scope: ${exclusion.path}.`);
      if (!/^(layout-only|redirect-only|error-page|provider-step-only|fixture-gap: \S.*)$/.test(exclusion.reason))
        throw new Error(`${surface.id}: Invalid exclusion reason: ${exclusion.path}.`);
      excluded.add(exclusion.path);
    }
  }
  for (const file of excluded) {
    if (claimed.has(file)) throw new Error(`Route both claimed and excluded: ${file}.`);
  }
}

export const browserUsabilityGoals = browserUsabilityGoalModules.flatMap((surface) =>
  surface.goals.map((goal) => ({ ...goal, startSignedIn: goal.startSignedIn ?? goal.role !== "guest" })),
);

export function selectBrowserUsabilityGoals(paths, goals = browserUsabilityGoals) {
  const shared =
    /^(packages\/design-system\/|contracts\/localization\/|bounded-contexts\/auth\/|bounded-contexts\/identity\/|deployables\/(marketplace|public-web)\/|scripts\/browser-usability)/;
  return goals.filter((goal) =>
    paths.some((file) =>
      shared.test(file)
        ? goal.selectOnSharedChange === true
        : goal.paths.some((prefix) => file.startsWith(prefix)) || Object.hasOwn(goal.routes ?? {}, file),
    ),
  );
}

export function browserUsabilityGoal(id) {
  const goal = browserUsabilityGoals.find((entry) => entry.id === id);
  if (!goal) throw new Error(`Unknown browser usability goal: ${id}`);
  return goal;
}

export function auditBrowserUsabilityRoutes(files, modules = browserUsabilityGoalModules) {
  const coverage = { unscoped: [], invalid: [], surfaces: {} };
  const routes = files.filter(
    (file) =>
      /^(bounded-contexts\/[^/]+\/routes\/|deployables\/(marketplace|admin-web|public-web)\/app\/routes\/)/.test(
        file,
      ) &&
      file.endsWith(".tsx") &&
      !/\.(test|spec)\.tsx$/.test(file),
  );
  const scopes = modules.map((surface) => ({
    surface,
    patterns: surface.routeScope.map((pattern) => new RegExp(pattern)),
  }));
  for (const { surface } of scopes)
    coverage.surfaces[surface.id] = { inScope: 0, claimed: 0, excluded: 0, unclaimed: [] };
  for (const file of routes) {
    const owners = scopes.filter(({ patterns }) => patterns.some((pattern) => pattern.test(file)));
    if (!owners.length) coverage.unscoped.push(file);
    if (owners.length > 1)
      coverage.invalid.push({
        path: file,
        reason: "multiple scopes",
        surfaces: owners.map(({ surface }) => surface.id),
      });
    for (const { surface } of owners) {
      const counts = coverage.surfaces[surface.id];
      counts.inScope++;
      const claimed = surface.goals.some((goal) => Object.hasOwn(goal.routes ?? {}, file));
      const excluded = surface.excludedRoutes.some((entry) => entry.path === file);
      if (claimed) counts.claimed++;
      if (excluded) counts.excluded++;
      if (claimed && excluded)
        coverage.invalid.push({ path: file, reason: "claimed and excluded", surfaces: [surface.id] });
      if (!claimed && !excluded) counts.unclaimed.push(file);
    }
  }
  return { coverage };
}

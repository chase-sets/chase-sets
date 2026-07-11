import { describe, expect, it } from "vitest";
import {
  buildComposeSmokeValues,
  composeSmokeAdminEmail,
  composeSmokeAdminPassword,
  composeSmokeComponentNames,
  composeSmokeInternalAuthSecret,
  composeSmokePlatformApiOrigin,
  composeSmokePostgresUrl,
  renderComposeSmokeEnvFile,
} from "./platform-compose-smoke.mjs";

function envValue(component, name) {
  return component.env.find((entry) => entry.name === name)?.value;
}

describe("platform-compose-smoke", () => {
  it("covers every enabled platform Helm component, matching the deployables the Dockerfile ships", () => {
    const names = composeSmokeComponentNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "public-web",
        "marketplace",
        "admin-web",
        "platform-api",
        "platform-worker",
        "platform-bootstrap",
      ]),
    );
  });

  it("substitutes every DATABASE_URL-shaped secret with the compose Postgres URL", () => {
    const values = buildComposeSmokeValues();
    for (const componentName of composeSmokeComponentNames({ values })) {
      const component = values.components[componentName];
      for (const entry of component.env) {
        if (entry.name.includes("DATABASE_URL") && entry.name !== "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL") {
          expect(entry.value, `${componentName}.${entry.name}`).toBe(composeSmokePostgresUrl);
        }
      }
    }
  });

  it("never leaves a secret-flagged entry undefined", () => {
    const values = buildComposeSmokeValues();
    for (const componentName of composeSmokeComponentNames({ values })) {
      for (const entry of values.components[componentName].env) {
        expect(typeof entry.value, `${componentName}.${entry.name}`).toBe("string");
      }
    }
  });

  it("points every web-facing component's internal API origin at the compose platform-api service", () => {
    // platform-worker talks to Postgres directly and never calls
    // platform-api over HTTP, so it (correctly) has no
    // CHASE_SETS_INTERNAL_API_ORIGIN entry in the Helm chart -- only
    // platform-api itself and the three web deployables do.
    const values = buildComposeSmokeValues();
    for (const componentName of ["public-web", "marketplace", "admin-web", "platform-api"]) {
      expect(envValue(values.components[componentName], "CHASE_SETS_INTERNAL_API_ORIGIN")).toBe(
        composeSmokePlatformApiOrigin,
      );
    }
  });

  it("wires consistent bootstrap admin credentials and internal auth secret across bootstrap and api", () => {
    const values = buildComposeSmokeValues();
    expect(envValue(values.components["platform-bootstrap"], "PLATFORM_ADMIN_EMAIL")).toBe(composeSmokeAdminEmail);
    expect(envValue(values.components["platform-bootstrap"], "PLATFORM_ADMIN_PASSWORD")).toBe(
      composeSmokeAdminPassword,
    );
    for (const componentName of ["platform-bootstrap", "platform-api"]) {
      expect(envValue(values.components[componentName], "PLATFORM_INTERNAL_AUTH_SECRET")).toBe(
        composeSmokeInternalAuthSecret,
      );
    }
  });

  it("adds the critical-bootstrap data profile the bootstrap job needs, since the base chart leaves it empty", () => {
    const values = buildComposeSmokeValues();
    expect(envValue(values.components["platform-bootstrap"], "PLATFORM_DATA_PROFILES")).toBe("critical-bootstrap");
  });

  it("skips the in-cluster preview-Postgres multi-database provisioning path", () => {
    const values = buildComposeSmokeValues();
    expect(envValue(values.components["platform-bootstrap"], "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL")).toBe("");
  });

  it("renders a component's env as KEY=value lines usable as a docker compose env_file", () => {
    const rendered = renderComposeSmokeEnvFile("platform-api");
    const lines = rendered.trim().split("\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z0-9_]+=.*$/);
    }
    expect(rendered).toContain(`PLATFORM_INTERNAL_AUTH_SECRET=${composeSmokeInternalAuthSecret}`);
  });

  it("throws for an unknown component", () => {
    expect(() => renderComposeSmokeEnvFile("does-not-exist")).toThrow(/Unknown platform Helm component/);
  });
});

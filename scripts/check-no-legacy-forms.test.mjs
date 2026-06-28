import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLegacyForms, collectLegacyFormViolations, summarizeViolations } from "./check-no-legacy-forms.mjs";

const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "no-legacy-forms-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("check-no-legacy-forms", () => {
  it("detects raw JSX forms and direct framework Form aliases", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx",
      `
import { Form as RouterForm } from "react-router";

export function SignInPage() {
  return (
    <section>
      <form method="post" />
      <RouterForm method="post" />
    </section>
  );
}
`,
    );

    const violations = await collectLegacyFormViolations({ rootDir });

    expect(violations.map((violation) => violation.kind)).toEqual([
      "frameworkFormImport",
      "rawJsxForm",
      "frameworkFormUsage",
    ]);
    expect(summarizeViolations(violations)).toEqual([
      {
        file: "bounded-contexts/auth/features/sign-in/ui/sign-in-page.tsx",
        rawJsxForm: 1,
        rawCreateElementForm: 0,
        frameworkFormImport: 1,
        frameworkFormUsage: 1,
      },
    ]);
  });

  it("rejects every legacy form without a migration baseline", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "deployables/marketplace/app/routes/layout.tsx",
      `
export function Layout() {
  return (
    <div>
      <form method="post" />
      <form method="post" />
    </div>
  );
}
`,
    );

    const result = await checkLegacyForms({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.newViolations).toEqual([
      {
        file: "deployables/marketplace/app/routes/layout.tsx",
        kind: "rawJsxForm",
        currentCount: 2,
        allowedCount: 0,
      },
    ]);
  });

  it("allows the exact shared Form implementation file to render the underlying native form", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/forms/form.tsx",
      `
export function Form() {
  return <form method="post" />;
}
`,
    );

    await expect(collectLegacyFormViolations({ rootDir })).resolves.toEqual([]);
  });

  it("allows only the exact router adapter file to import framework Form", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/forms/router-form.tsx",
      `
import { Form as ReactRouterForm } from "react-router";

export function RouterForm() {
  return <ReactRouterForm method="post" />;
}
`,
    );

    await expect(collectLegacyFormViolations({ rootDir })).resolves.toEqual([]);
  });

  it("detects imperative raw form creation", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx",
      `
import { createElement } from "react";

export function SupportRequestListPage() {
  const first = createElement("form", { method: "post" });
  const second = React.createElement("form", { method: "get" });
  return <section>{first}{second}</section>;
}
`,
    );

    expect(await collectLegacyFormViolations({ rootDir })).toEqual([
      {
        kind: "rawCreateElementForm",
        file: "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx",
        line: 5,
        column: 31,
        detail: 'createElement("form")',
      },
      {
        kind: "rawCreateElementForm",
        file: "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx",
        line: 6,
        column: 38,
        detail: 'createElement("form")',
      },
    ]);
  });

  it("detects framework Form re-exports and namespace member usage", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/forms/legacy-router-form.tsx",
      `
import * as Router from "react-router";

export { Form as LegacyRouterForm } from "react-router";

export const BypassedForm = Router.Form;
`,
    );

    expect(await collectLegacyFormViolations({ rootDir })).toEqual([
      {
        kind: "frameworkFormImport",
        file: "packages/design-system/src/components/forms/legacy-router-form.tsx",
        line: 4,
        column: 18,
        detail: "react-router",
      },
      {
        kind: "frameworkFormUsage",
        file: "packages/design-system/src/components/forms/legacy-router-form.tsx",
        line: 6,
        column: 36,
        detail: "framework Form member usage",
      },
    ]);
  });

  it("rejects every remaining legacy form in final mode", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/checkout/routes/checkout-start.tsx",
      `
import { Form } from "react-router";

export function CheckoutStart() {
  return <Form method="post" />;
}
`,
    );

    const result = await checkLegacyForms({ rootDir });

    expect(result.passed).toBe(false);
    expect(result.newViolations).toEqual([
      {
        file: "bounded-contexts/checkout/routes/checkout-start.tsx",
        kind: "frameworkFormImport",
        currentCount: 1,
        allowedCount: 0,
      },
      {
        file: "bounded-contexts/checkout/routes/checkout-start.tsx",
        kind: "frameworkFormUsage",
        currentCount: 1,
        allowedCount: 0,
      },
    ]);
  });
});

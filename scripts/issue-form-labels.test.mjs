import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  isTrustedAuthorAssociation,
  labelsToAdd,
  main,
  parseIssueFormLabels,
  readFormField,
} from "./issue-form-labels.mjs";

const FILLED = [
  "### Priority",
  "",
  "p1",
  "",
  "### Owning context",
  "",
  "catalog",
  "",
  "### Kind",
  "",
  "tech-debt",
  "",
  "### Context",
  "",
  "Because the projection drifts. See bounded-contexts/catalog/README.md.",
  "",
].join("\n");

const REPOSITORY = "chase-sets/chase-sets";
const ISSUE_NUMBER = "6171";
const ISSUE_URL = `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`;
const LABELS_URL = `${ISSUE_URL}/labels`;
const HEADERS = {
  accept: "application/vnd.github+json",
  authorization: "Bearer test-token",
  "x-github-api-version": "2022-11-28",
};
const COMPLETE_ENV = {
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_TOKEN: "test-token",
  ISSUE_NUMBER,
};

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function createHarness(issue, { issueStatus = 200, labelStatus = 200 } = {}) {
  const requests = [];
  const logs = [];
  const errors = [];
  const client = async (url, init = {}) => {
    requests.push({ url, init });
    if ((init.method ?? "GET") === "POST") {
      return response(labelStatus, labelStatus >= 200 && labelStatus < 300 ? {} : "label failure");
    }
    return response(issueStatus, issueStatus >= 200 && issueStatus < 300 ? issue : "fetch failure");
  };
  const logger = {
    log(message) {
      logs.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
  return { client, errors, logger, logs, requests };
}

function issueWithAssociation(association, { includeKey = true, body = FILLED, labels = [] } = {}) {
  return {
    body,
    labels,
    ...(includeKey ? { author_association: association } : {}),
  };
}

function getRequest() {
  return {
    url: ISSUE_URL,
    init: { headers: HEADERS },
  };
}

function postRequest(labels = ["priority:p1", "area:catalog", "kind:tech-debt"]) {
  return {
    url: LABELS_URL,
    init: {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ labels }),
    },
  };
}

async function runMain(harness, env = COMPLETE_ENV) {
  return main({ env, client: harness.client, logger: harness.logger });
}

function findMainAssociationGate(sourceText) {
  const sourceFile = ts.createSourceFile(
    "scripts/issue-form-labels.mjs",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let mainFunction;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "main") {
      mainFunction = node;
    }
  });
  if (!mainFunction?.body) return null;

  function containsCall(node, predicate) {
    let found = false;
    function visit(child) {
      if (ts.isCallExpression(child) && predicate(child)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }

  const statements = [...mainFunction.body.statements];
  const guardIndex = statements.findIndex(
    (statement) =>
      ts.isIfStatement(statement) &&
      containsCall(
        statement.expression,
        (call) =>
          ts.isIdentifier(call.expression) &&
          call.expression.text === "isTrustedAuthorAssociation" &&
          call.arguments.some(
            (argument) =>
              ts.isPropertyAccessExpression(argument) &&
              ts.isIdentifier(argument.expression) &&
              argument.expression.text === "issue" &&
              argument.name.text === "author_association",
          ),
      ) &&
      containsCall(
        statement.thenStatement,
        (call) => ts.isIdentifier(call.expression) && call.expression.text === "String",
      ) &&
      statement.thenStatement
        .getChildren(sourceFile)
        .some((child) => ts.isSyntaxList(child) && child.getChildren(sourceFile).some(ts.isReturnStatement)),
  );
  const postIndex = statements.findIndex((statement) =>
    containsCall(statement, (call) => {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== "client") return false;
      const init = call.arguments[1];
      if (!init || !ts.isObjectLiteralExpression(init)) return false;
      return init.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(sourceFile) === "method" &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === "POST",
      );
    }),
  );

  return { guardIndex, postIndex };
}

describe("issue form label parsing", () => {
  it("reads a dropdown answer", () => {
    expect(readFormField(FILLED, "Priority")).toBe("p1");
    expect(readFormField(FILLED, "Owning context")).toBe("catalog");
  });

  it("returns null for missing or empty answers", () => {
    expect(readFormField(FILLED, "Nonexistent")).toBeNull();
    expect(readFormField("### Priority\n\n\n### Kind\n\nproduct\n", "Priority")).toBeNull();
    expect(readFormField(null, "Priority")).toBeNull();
  });

  it("does not bleed the next section into an answer", () => {
    expect(readFormField(FILLED, "Kind")).toBe("tech-debt");
    expect(readFormField(FILLED, "Context")).toContain("projection drifts");
  });

  it("maps answers to the label families", () => {
    expect(parseIssueFormLabels(FILLED)).toEqual(["priority:p1", "area:catalog", "kind:tech-debt"]);
  });

  it("maps the channels owning-context answer to its registered area label", () => {
    expect(parseIssueFormLabels("### Owning context\n\nchannels\n")).toEqual(["area:channels"]);
  });

  it("ignores values outside the allowed vocabulary", () => {
    const body = "### Priority\n\np9\n\n### Owning context\n\nnot-a-context\n";
    expect(parseIssueFormLabels(body)).toEqual([]);
  });

  it("is case-insensitive on the answer", () => {
    expect(parseIssueFormLabels("### Priority\n\nP0\n")).toEqual(["priority:p0"]);
  });

  it("skips labels already present", () => {
    expect(labelsToAdd(FILLED, [{ name: "priority:p1" }])).toEqual(["area:catalog", "kind:tech-debt"]);
  });

  it("preserves additive one-label-per-family behavior", () => {
    expect(labelsToAdd(FILLED, [{ name: "priority:p2" }])).toEqual(["area:catalog", "kind:tech-debt"]);
    expect(labelsToAdd(FILLED, [{ name: "area:discovery" }, { name: "kind:product" }])).toEqual(["priority:p1"]);
  });

  it("adds nothing for a no-response answer", () => {
    expect(labelsToAdd("### Priority\n\n_No response_\n", [])).toEqual([]);
  });

  it("adds nothing for an out-of-allowlist answer", () => {
    expect(labelsToAdd("### Priority\n\np9\n", [])).toEqual([]);
  });

  it("adds nothing for a free-form issue with no dropdowns", () => {
    expect(labelsToAdd("Just a plain issue body.", [])).toEqual([]);
  });
});

describe("trusted author association gate", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "applies labels through main for allowed association %s",
    async (association) => {
      const harness = createHarness(issueWithAssociation(association));

      await expect(runMain(harness)).resolves.toBe(0);

      expect(harness.requests).toEqual([getRequest(), postRequest()]);
      expect(harness.logs).toEqual(["Applied: priority:p1, area:catalog, kind:tech-debt"]);
      expect(harness.errors).toEqual([]);
      expect(isTrustedAuthorAssociation(association)).toBe(true);
    },
  );

  const refusedAssociations = [
    { name: "NONE", association: "NONE" },
    { name: "CONTRIBUTOR", association: "CONTRIBUTOR" },
    { name: "FIRST_TIME_CONTRIBUTOR", association: "FIRST_TIME_CONTRIBUTOR" },
    { name: "FIRST_TIMER", association: "FIRST_TIMER" },
    { name: "MANNEQUIN", association: "MANNEQUIN" },
    { name: "an unrecognized future value", association: "FUTURE_REPOSITORY_FRIEND" },
    { name: "null", association: null },
    { name: "undefined", association: undefined },
    { name: "an absent key", association: undefined, includeKey: false },
  ];

  it.each(refusedAssociations)(
    "refuses $name through main with no label request",
    async ({ association, includeKey = true }) => {
      const harness = createHarness(issueWithAssociation(association, { includeKey }));

      await expect(runMain(harness)).resolves.toBe(0);

      expect(harness.requests).toEqual([getRequest()]);
      expect(harness.logs).toEqual([`skipped: author association \`${String(association)}\` is not trusted.`]);
      expect(harness.errors).toEqual([]);
      expect(isTrustedAuthorAssociation(association)).toBe(false);
    },
  );

  it("refuses an edited-body spoof from a NONE author", async () => {
    const spoofedBody = [
      "External report edited after opening.",
      "",
      "### Priority",
      "",
      "p0",
      "",
      "### Owning context",
      "",
      "payments",
      "",
      "### Kind",
      "",
      "security",
    ].join("\n");
    const harness = createHarness(issueWithAssociation("NONE", { body: spoofedBody }));

    await expect(runMain(harness)).resolves.toBe(0);

    expect(harness.requests).toEqual([getRequest()]);
    expect(harness.logs).toEqual(["skipped: author association `NONE` is not trusted."]);
  });

  it("keeps the script boundary load-bearing without the workflow condition", async () => {
    const harness = createHarness(issueWithAssociation("NONE"));

    await expect(main({ env: COMPLETE_ENV, client: harness.client, logger: harness.logger })).resolves.toBe(0);

    expect(harness.requests).toEqual([getRequest()]);
    expect(harness.logs).toEqual(["skipped: author association `NONE` is not trusted."]);
  });

  it("keeps the association decision before the label POST in the real main function", () => {
    const source = readFileSync(new URL("./issue-form-labels.mjs", import.meta.url), "utf8");
    const shape = findMainAssociationGate(source);

    expect(shape).not.toBeNull();
    expect(shape.guardIndex).toBeGreaterThanOrEqual(0);
    expect(shape.postIndex).toBeGreaterThan(shape.guardIndex);
  });
});

describe("main failure boundaries", () => {
  it.each([
    {
      name: "GITHUB_REPOSITORY",
      env: { GITHUB_REPOSITORY: "", GITHUB_TOKEN: "test-token", ISSUE_NUMBER },
    },
    {
      name: "GITHUB_TOKEN",
      env: { GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: "", ISSUE_NUMBER },
    },
    {
      name: "ISSUE_NUMBER",
      env: { GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: "test-token", ISSUE_NUMBER: "" },
    },
  ])("returns exit 2 for a missing $name with all ambient inputs overridden", async ({ env }) => {
    const harness = createHarness(issueWithAssociation("MEMBER"));

    await expect(runMain(harness, env)).resolves.toBe(2);

    expect(harness.requests).toEqual([]);
    expect(harness.logs).toEqual([]);
    expect(harness.errors).toEqual(["GITHUB_REPOSITORY, GITHUB_TOKEN and ISSUE_NUMBER are required."]);
  });

  it("throws when the issue fetch is non-OK", async () => {
    const harness = createHarness(issueWithAssociation("MEMBER"), { issueStatus: 502 });

    await expect(runMain(harness)).rejects.toThrow("Failed to read issue: 502 fetch failure");

    expect(harness.requests).toEqual([getRequest()]);
    expect(harness.logs).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("throws when the label POST is non-OK", async () => {
    const harness = createHarness(issueWithAssociation("MEMBER"), { labelStatus: 422 });

    await expect(runMain(harness)).rejects.toThrow("Failed to add labels: 422 label failure");

    expect(harness.requests).toEqual([getRequest(), postRequest()]);
    expect(harness.logs).toEqual([]);
    expect(harness.errors).toEqual([]);
  });
});

describe("issue form label workflow structure", () => {
  const workflowSource = readFileSync(new URL("../.github/workflows/issue-form-labels.yml", import.meta.url), "utf8");
  const workflow = parseYaml(workflowSource);
  const labelJob = workflow.jobs.label;

  it("keeps the default-branch issues trigger and least-privilege permissions", () => {
    expect(workflow.on).toEqual({ issues: { types: ["opened", "edited"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(labelJob.permissions).toEqual({ contents: "read", issues: "write" });
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");

    const checkout = labelJob.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout).toBeDefined();
    expect(checkout.with).toBeUndefined();
  });

  it("uses the trusted association allowlist alongside the body cost gate", () => {
    expect(labelJob.if).toContain("contains(github.event.issue.body, '### Priority')");
    expect(labelJob.if).toContain("github.event.issue.author_association == 'OWNER'");
    expect(labelJob.if).toContain("github.event.issue.author_association == 'MEMBER'");
    expect(labelJob.if).toContain("github.event.issue.author_association == 'COLLABORATOR'");
    expect(workflowSource).toMatch(
      /Cost gate only: skipped jobs conclude success\.[\s\S]*load-bearing security boundary\./,
    );
  });

  it("does not swallow script failures at an advisory boundary", () => {
    expect(labelJob["continue-on-error"]).toBeUndefined();
    expect(labelJob.steps.every((step) => step["continue-on-error"] === undefined)).toBe(true);
    const applyStep = labelJob.steps.find((step) => step.name === "Apply form labels");
    expect(applyStep.run.trim()).toBe("node ./scripts/issue-form-labels.mjs");
    expect(applyStep.run).not.toMatch(/\bexit\s+0\b/);
  });
});

// @vitest-environment node
import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { participantActions } from "../domain/participant-attempt";
import { participantFixture, openBody } from "./participant-attempt.test-support";

function posts(source: string) {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { path: string; handler: ts.Expression | undefined }[] = [];
  function walk(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "app" &&
      node.expression.name.text === "post"
    ) {
      const path = node.arguments[0];
      if (!path || !ts.isStringLiteral(path)) throw new Error("INDETERMINATE: unknown Hono mutation shape");
      found.push({ path: path.text, handler: node.arguments[1] });
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
  return found;
}
function partition(source: string) {
  const classified = new Set([
    ...Object.values(participantActions).map((entry) => entry.path),
    "/:id/attachments",
    "/:id/resolve",
    "/participant-attempts/:attemptId/attachments",
  ]);
  const participants = posts(source).filter(({ path }) => !path.startsWith("/ops/"));
  for (const { path, handler } of participants) {
    if (!classified.has(path as never)) throw new Error(`INDETERMINATE: ${path}`);
    const action = Object.entries(participantActions).find(([, entry]) => entry.path === path)?.[0];
    if (!action) continue;
    if (
      !handler ||
      !ts.isArrowFunction(handler) ||
      !ts.isCallExpression(handler.body) ||
      !ts.isIdentifier(handler.body.expression) ||
      handler.body.expression.text !== "executeParticipantCommand" ||
      handler.body.arguments.length !== 2 ||
      !ts.isStringLiteral(handler.body.arguments[0]) ||
      handler.body.arguments[0].text !== action
    )
      throw new Error(`INDETERMINATE: action binding ${path}`);
  }
  return participants.map(({ path }) => path);
}
const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const client = readFileSync(
  new URL("../../../support/request-support/support-request-api-client.ts", import.meta.url),
  "utf8",
);
const forms = readFileSync(new URL("../ui/support-request-detail-page.tsx", import.meta.url), "utf8");
const context = JSON.parse(readFileSync(new URL("../../../context.json", import.meta.url), "utf8"));

describe("support participant mutation inventory", () => {
  it("keeps offer derivation participant-only and after the v1 hash check", () => {
    const runtime = readFileSync(new URL("./participant-runtime.ts", import.meta.url), "utf8");
    const domain = readFileSync(new URL("../domain/domain.ts", import.meta.url), "utf8");
    const operations = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
    const derivation = "offerResolutionType: b.offerResolutionType ?? expectedOfferResolution(b.responseType)";
    expect(runtime.indexOf(derivation)).toBeGreaterThan(runtime.indexOf("digest(canonical) !== attempt.requestHash"));
    expect(runtime).toContain("canonicalParticipantRequest(input.actionKind, input.body)");
    expect(domain.match(/function expectedOfferResolution\(/g)).toHaveLength(1);
    expect(domain).toContain(
      'assert(expectedResolution === resolutionType, "Offer resolution does not match the response type.")',
    );
    expect(operations).not.toContain("expectedOfferResolution");
    expect(route).toContain('typeof body.offerResolutionType === "string" ? body.offerResolutionType : null');
  });
  it("derives nine routes, client commands, form intents and the owning context row", () => {
    expect(
      partition(route)
        .filter(
          (path) =>
            path !== "/:id/attachments" &&
            path !== "/:id/resolve" &&
            path !== "/participant-attempts/:attemptId/attachments",
        )
        .sort(),
    ).toEqual(
      Object.values(participantActions)
        .map((entry) => entry.path)
        .sort(),
    );
    const stagingRoutes = partition(route).filter((path) => path.startsWith("/participant-attempts/"));
    expect(stagingRoutes).toEqual(["/participant-attempts/:attemptId/attachments"]);
    const tree = ts.createSourceFile("client.ts", client, ts.ScriptTarget.Latest, true);
    const kinds = new Set<string>();
    function walk(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "participantCommand" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        kinds.add(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(tree);
    expect([...kinds].sort()).toEqual(Object.keys(participantActions).sort());
    const formTree = ts.createSourceFile("forms.tsx", forms, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const intents = new Set<string>();
    function formWalk(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(formTree) === "HiddenInput") {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        if (
          attributes.some(
            (a) =>
              a.name.getText(formTree) === "name" &&
              a.initializer &&
              ts.isStringLiteral(a.initializer) &&
              a.initializer.text === "intent",
          )
        ) {
          const value = attributes.find((a) => a.name.getText(formTree) === "value")?.initializer;
          if (!value || !ts.isStringLiteral(value)) throw new Error("INDETERMINATE: form intent shape");
          intents.add(value.text);
        }
      }
      ts.forEachChild(node, formWalk);
    }
    formWalk(formTree);
    expect([...intents].sort()).toEqual(
      ["evidence", "response", "accept-offer", "decline-offer", "escalate", "cancel"].sort(),
    );
    expect(
      context.readAfterWriteRouteInventory.some(
        (row: { source: { command: string } }) => row.source.command === "Participant support request commands",
      ),
    ).toBe(true);
  });
  it("new and unknown-shape mutations refuse INDETERMINATE, including a tenth executable participant", () => {
    expect(() => partition(`${route}\napp.post('/new-mutation', handler);`)).toThrow("INDETERMINATE");
    expect(() => partition(`${route}\napp.post('/participant-attempts/:attemptId/other', handler);`)).toThrow(
      "INDETERMINATE",
    );
    expect(() => partition(`${route}\napp.post(dynamicPath, handler);`)).toThrow("INDETERMINATE");
    expect(partition(route)).toContain("/:id/resolve");
  });
  it("each derived participant path binds its own action handler, not another action or bypass", () => {
    expect(() =>
      partition(
        route.replace('executeParticipantCommand("submit-evidence", c)', 'executeParticipantCommand("cancel", c)'),
      ),
    ).toThrow("INDETERMINATE");
    expect(() =>
      partition(route.replace('executeParticipantCommand("submit-evidence", c)', "oldUnprotectedCommand(c)")),
    ).toThrow("INDETERMINATE");
  });
  it("receipt-aware opening redirects reuse the existing detail freshness owner", () => {
    const entry = context.readAfterWriteRouteInventory.find(
      (row: { id: string }) => row.id === "platform-operations.support-request-detail-fresh-read",
    );
    expect(entry.source.routeIds).toContain("account-support");
    expect(entry.destination.routeId).toBe("account-support-detail");
    expect(entry.destination.apiRoutePath).toBe("/support-requests/:id");
    const routes = context.apiMounts.find(
      (mount: { mountPath: string }) => mount.mountPath === "/api/marketplace",
    ).readFreshnessRoutes;
    expect(routes).toContainEqual({
      routePath: entry.destination.apiRoutePath,
      methods: ["GET", "HEAD"],
      dependencies: [{ readModelTable: "support_request_pages" }],
    });
  });
  it("real resolve route/runtime/domain refuses participant adjudication with zero append", async () => {
    const f = participantFixture();
    const opened = await f.executeParticipant("open-support-request", openBody);
    f.db.query.mockResolvedValue({
      rows: [
        {
          support_request_id: opened.id,
          buyer_account_id: "acc_buyer",
          seller_account_id: "acc_seller",
          resolution: null,
          order_return_context: [],
          case_presentation: {},
          return_shipping: null,
        },
      ],
    } as never);
    const before = f.allEvents.length;
    const response = await f.app.request(`/support-requests/${opened.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resolutionType: "full-refund",
        summary: "Finding",
        responsibility: "seller",
        evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
        responsibilityReasonCode: "product-not-received.seller-did-not-ship",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Only support can adjudicate");
    expect(f.allEvents).toHaveLength(before);
  });
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { hasIdentifierSubmitHandler } from "../e2e/support/sign-in-readiness";

type Stage = "identifier" | "password";
type Journey = { title: string; run: (fixtures: { page: object }) => Promise<void> };
const source = readFileSync(new URL("../e2e/auth-form-pending.spec.ts", import.meta.url), "utf8");
const titles = [
  "sign-in pointer submit blocks double submission and keeps focus on the submitter @marketplace-account @browser-e2e-seed",
  "sign-in Enter submit blocks double submission and keeps focus on the password field @marketplace-account @browser-e2e-seed",
  "sign-in without JavaScript completes through a document POST @marketplace-account @browser-e2e-seed",
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isReadinessBarrier(node: ts.Node, locator: string) {
  if (!ts.isExpressionStatement(node) || !ts.isAwaitExpression(node.expression)) return false;
  const assertion = node.expression.expression;
  if (!ts.isCallExpression(assertion) || !ts.isPropertyAccessExpression(assertion.expression)) return false;
  if (assertion.expression.name.text !== "toBe") return false;
  const poll = assertion.expression.expression;
  if (!ts.isCallExpression(poll) || !ts.isPropertyAccessExpression(poll.expression)) return false;
  if (poll.expression.name.text !== "poll") return false;
  const probe = poll.arguments[0];
  if (!probe || !ts.isArrowFunction(probe) || !ts.isCallExpression(probe.body)) return false;
  const evaluation = probe.body;
  if (!ts.isPropertyAccessExpression(evaluation.expression)) return false;
  const receiver = evaluation.expression.expression;
  const predicate = evaluation.arguments[0];
  return (
    evaluation.expression.name.text === "evaluate" &&
    ts.isIdentifier(receiver) &&
    receiver.text === locator &&
    predicate !== undefined &&
    ts.isIdentifier(predicate) &&
    predicate.text === "hasIdentifierSubmitHandler"
  );
}

function collectJourneys(browserExpect: object, removeBarrier?: Stage) {
  const journeys: Journey[] = [];
  const register = Object.assign((title: string, run: Journey["run"]) => journeys.push({ title, run }), {
    describe: (_title: string, body: () => void) => body(),
  });
  let removed = 0;
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    transformers: {
      before: [
        (context) => {
          const visit: ts.Visitor = (node) => {
            if (removeBarrier && isReadinessBarrier(node, removeBarrier === "identifier" ? "identifierForm" : "form")) {
              removed++;
              return context.factory.createEmptyStatement();
            }
            return ts.visitEachChild(node, visit, context);
          };
          return (file) => ts.visitNode(file, visit) as ts.SourceFile;
        },
      ],
    },
  });
  runInNewContext(output.outputText, {
    exports: {},
    URL,
    require: (name: string) => {
      if (name === "@playwright/test") return { test: register, expect: browserExpect };
      if (name === "./support/sign-in-readiness") return { hasIdentifierSubmitHandler };
      if (name === "./support/seed-contract") {
        return {
          marketplaceBrowserE2eBuyerCredentials: () => ({ email: "synthetic@example.test", password: "synthetic" }),
        };
      }
      throw new Error(`Unexpected spec dependency: ${name}`);
    },
  });
  return { journeys, removed };
}

function browserControl(
  delayed: Stage,
  options: {
    assertionError?: Error;
    cleanupError?: Error;
    nativePost?: boolean;
    finishContinuation?: Promise<void>;
  } = {},
) {
  const unready = deferred();
  const hydrated = deferred();
  const continuing = deferred();
  const forms = { identifier: document.createElement("form"), password: document.createElement("form") };
  const hydrate = (stage: Stage) => Object.assign(forms[stage], { __reactProps$control: { onSubmit() {} } });
  hydrate(delayed === "identifier" ? "password" : "identifier");
  const actions: string[] = [];
  const handlers: Promise<void>[] = [];
  let intercept: ((route: object) => Promise<void>) | undefined;
  let posts = 0;
  let busy = false;
  let focused = "";
  let url = new URL("https://synthetic.example/sign-in?returnTo=%2Faccount%2Fcart");
  let continued = false;
  let disposed = false;
  let busyChecked = false;

  function submit(stage: Stage, focus: string) {
    actions.push(`${stage}:submit`);
    if (!hasIdentifierSubmitHandler(forms[stage])) throw new Error(`Native ${stage} submission while unready`);
    if (stage === "identifier" || busy) return;
    busy = true;
    focused = focus;
    posts++;
    const route = {
      request: () => ({
        method: () => "POST",
        url: () => `https://synthetic.example/sign-in${options.nativePost ? "" : ".data"}`,
        isNavigationRequest: () => options.nativePost ?? false,
      }),
      continue: async () => {
        continued = true;
        continuing.resolve();
        await options.finishContinuation;
        url = new URL("https://synthetic.example/account/cart");
        busy = false;
      },
    };
    if (!intercept) throw new Error("Password submit was not intercepted");
    const handler = intercept(route);
    handlers.push(handler);
    void handler.catch(() => {});
  }

  function field(stage: Stage) {
    return {
      kind: stage,
      fill: async () => {
        actions.push(`${stage}:fill`);
      },
      press: async () => submit(stage, "password"),
      locator: () => form(stage),
    };
  }
  function form(stage: Stage) {
    return {
      evaluate: async (predicate: typeof hasIdentifierSubmitHandler) => {
        expect(predicate).toBe(hasIdentifierSubmitHandler);
        return predicate(forms[stage]);
      },
      getByRole: () => ({ kind: "submitter", click: async () => submit("password", "submitter") }),
    };
  }
  const page = {
    goto: async () => {},
    getByLabel: (name: RegExp) => field(name.test("Email or phone") ? "identifier" : "password"),
    getByRole: (role: string) => ({
      click: async () => {
        if (role === "button") submit("identifier", "continue");
      },
    }),
    route: async (_pattern: string, handler: typeof intercept) => {
      intercept = handler;
    },
    unrouteAll: async () => {
      await Promise.all(handlers);
      disposed = true;
      if (options.cleanupError) throw options.cleanupError;
    },
  };
  const browserExpect = Object.assign(
    (actual: unknown) => ({
      toBe: (expected: unknown) => expect(actual).toBe(expected),
      toHaveAttribute: async () => {
        busyChecked = true;
        if (options.assertionError) throw options.assertionError;
        expect(busy).toBe(true);
      },
      toBeEnabled: async () => {},
      toBeFocused: async () => expect(focused).toBe((actual as { kind: string }).kind),
      toHaveURL: async (expected: RegExp | ((value: URL) => boolean)) => {
        if (typeof expected === "function") expect(expected(url)).toBe(true);
        else {
          await Promise.all(handlers);
          expect(url.href).toMatch(expected);
        }
      },
    }),
    {
      poll: (probe: () => Promise<boolean>) => ({
        toBe: async (expected: boolean) => {
          if ((await probe()) !== expected) {
            unready.resolve();
            await hydrated.promise;
          }
          expect(await probe()).toBe(expected);
        },
      }),
    },
  );
  return {
    page,
    browserExpect,
    actions,
    handlers,
    unready,
    continuing,
    releaseHydration: () => {
      hydrate(delayed);
      hydrated.resolve();
    },
    state: () => ({ posts, continued, disposed, busyChecked }),
  };
}

async function exercise(index: number, stage: Stage, removeBarrier?: Stage) {
  const control = browserControl(stage);
  const { journeys, removed } = collectJourneys(control.browserExpect, removeBarrier);
  const run = journeys[index].run({ page: control.page });
  const settled = run.then(
    () => "settled",
    () => "settled",
  );
  try {
    expect(await Promise.race([control.unready.promise.then(() => "unready"), settled])).toBe("unready");
    expect(control.actions).not.toContain(`${stage}:fill`);
    expect(control.actions).not.toContain(`${stage}:submit`);
  } finally {
    control.releaseHydration();
    await settled;
  }
  await run;
  expect(control.state()).toEqual({ posts: 1, continued: true, disposed: true, busyChecked: true });
  return removed;
}

describe("auth pending callable form readiness", () => {
  it.each<[string, object]>([
    ["SSR", {}],
    ["missing handler", { __reactProps$control: {} }],
    ["noncallable handler", { __reactProps$control: { onSubmit: true } }],
    ["null metadata", { __reactProps$control: null }],
    ["descendant-only handler", { children: [{ __reactProps$control: { onSubmit() {} } }] }],
    ["non-React metadata", { props: { onSubmit() {} } }],
  ])("rejects %s", (_name, element) => {
    expect(hasIdentifierSubmitHandler(element)).toBe(false);
  });

  it("accepts a callable handler on the actual form", () => {
    const form = document.createElement("form");
    Object.assign(form, { __reactProps$control: { onSubmit() {} } });
    expect(hasIdentifierSubmitHandler(form)).toBe(true);
  });

  it("preserves all three browser identities and order", () => {
    expect(collectJourneys({}).journeys.map(({ title }) => title)).toEqual(titles);
  });

  for (const [index, journey] of ["pointer", "Enter"].entries()) {
    for (const stage of ["identifier", "password"] as const) {
      it(`${journey} waits without interaction for delayed ${stage} hydration, then submits`, async () => {
        await exercise(index, stage);
      });

      it(`${journey} detects removal of only the ${stage} barrier`, async () => {
        const { removed } = collectJourneys({}, stage);
        expect(removed).toBe(2);
        await expect(exercise(index, stage, stage)).rejects.toThrow("expected 'settled' to be 'unready'");
      });
    }

    it(`${journey} releases and settles a held route without masking the primary failure`, async () => {
      const primary = new Error("synthetic pending assertion failure");
      const finish = deferred();
      const control = browserControl("password", {
        assertionError: primary,
        cleanupError: new Error("synthetic cleanup failure"),
        finishContinuation: finish.promise,
      });
      control.releaseHydration();
      const run = collectJourneys(control.browserExpect).journeys[index].run({ page: control.page });
      let settled = false;
      const terminal = run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        expect(
          await Promise.race([control.continuing.promise.then(() => "continuing"), terminal.then(() => "settled")]),
        ).toBe("continuing");
        expect(settled).toBe(false);
      } finally {
        finish.resolve();
        await terminal;
      }
      await expect(run).rejects.toBe(primary);
      expect(control.state()).toEqual({ posts: 1, continued: true, disposed: true, busyChecked: true });
      await Promise.allSettled(control.handlers);
    });

    it(`${journey} makes a cleanup-only failure red`, async () => {
      const cleanup = new Error("synthetic cleanup failure");
      const control = browserControl("password", { assertionError: undefined, cleanupError: cleanup });
      control.releaseHydration();
      await expect(collectJourneys(control.browserExpect).journeys[index].run({ page: control.page })).rejects.toBe(
        cleanup,
      );
    });

    it(`${journey} rejects document POST transport in the JavaScript journey`, async () => {
      const control = browserControl("password", { nativePost: true });
      control.releaseHydration();
      await expect(
        collectJourneys(control.browserExpect).journeys[index].run({ page: control.page }),
      ).rejects.toThrow();
    });
  }
});

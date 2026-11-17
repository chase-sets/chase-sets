// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { ChaseRoot } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { ReviewMutationForm, type ReviewMutationPhase } from "../features/reviews/ui/review-mutation-form";
import { runReviewMutation } from "../support/route-support/review-mutation-action";
import { marketplaceRequestHash } from "../features/mutation-recovery/api/client";
import PurchaseReviewRoute, {
  action as purchaseAction,
  shouldRevalidate,
} from "../routes/marketplace/account-purchase-review";
import SaleReviewRoute, { action as saleAction } from "../routes/marketplace/account-sale-review";
import AccountReviewRoute from "../routes/marketplace/account-review";
import { jsonResponse, requestUrl } from "./test-support/http";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("review recovery through a real data router", () => {
  it.each([
    {
      name: "purchase",
      path: "/account/purchases/:purchaseId/review",
      url: "/account/purchases/ord_one/review",
      action: purchaseAction,
      Component: PurchaseReviewRoute,
      role: "buyer",
    },
    {
      name: "sale",
      path: "/account/sales/:orderId/review",
      url: "/account/sales/ord_one/review",
      action: saleAction,
      Component: SaleReviewRoute,
      role: "seller",
    },
  ])(
    "recovers the production $name form after commit-then-loss without using opportunity presence as evidence",
    async ({ path, url, action, Component, role }) => {
      const write = deferred<Response>();
      const observation = deferred<void>();
      const sent: Record<string, unknown>[] = [];
      let lookups = 0;
      let opportunityReads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const target = requestUrl(input);
          if (target.includes("/api/auth/session"))
            return jsonResponse({
              actor: {
                sessionId: "ses_one",
                tenantId: "tnt_identity",
                userId: "usr_actor",
                accountId: "acc_actor",
                membershipId: "mbr_one",
                roleKey: "owner",
                permissions: ["reputation.view", "reputation.manage"],
              },
            });
          if (target.includes("/opportunities/")) {
            opportunityReads++;
            return jsonResponse({ active_review_id: "rev_unrelated_projection" });
          }
          if (target.includes("/mutation-attempts/")) {
            lookups++;
            await observation.promise;
            const parsed = new URL(target);
            const attemptId = decodeURIComponent(parsed.pathname.split("/").at(-1)!);
            return jsonResponse({
              schemaVersion: 1,
              mutationKind: "review.submit",
              actorBinding: { accountId: "acc_actor" },
              target: { kind: "order", id: "ord_one" },
              canonicalRequestHash: parsed.searchParams.get("requestHash"),
              attemptKeyFingerprint: await marketplaceRequestHash([
                "acc_actor",
                "review.submit",
                { kind: "order", id: "ord_one" },
                attemptId,
              ]),
              ownerStatus: "committed",
              ownerReceipt: { id: "rev_first", version: 2 },
            });
          }
          if (target.endsWith("/reviews")) {
            const request = input instanceof Request ? input : new Request(target, init);
            sent.push((await request.json()) as Record<string, unknown>);
            return write.promise;
          }
          throw new Error(`Unexpected request: ${target}`);
        }),
      );
      const router = createMemoryRouter(
        [
          {
            id: "review",
            path,
            action,
            shouldRevalidate,
            loader: () => ({
              opportunity: {
                order_id: "ord_one",
                subject_account_id: "acc_subject",
                subject_display_name: "Counterparty",
                author_role: role,
                eligible_at: new Date().toISOString(),
                active_review_id: null,
              },
            }),
            element: <Component />,
          },
          { path: "/account/reviews/:reviewId", element: <p>First Review recovered</p> },
        ],
        { initialEntries: [url] },
      );
      try {
        render(
          <ChaseRoot>
            <RouterProvider router={router} />
          </ChaseRoot>,
        );
        fireEvent.click(await screen.findByRole("button", { name: "Submit account review" }));
        await screen.findByText("Submitting");
        await waitFor(() => expect(sent).toHaveLength(1));
        await act(async () => write.reject(new TypeError("Committed response lost")));
        await screen.findByText("Confirming the first result");
        await waitFor(() => expect(lookups).toBe(1));
        await act(async () => observation.resolve());
        await screen.findByText("First Review recovered");
        expect(router.state.location.pathname).toBe("/account/reviews/rev_first");
        expect(sent[0]).toMatchObject({ subjectAccountId: "acc_subject", orderId: "ord_one", rating: 5 });
        expect(opportunityReads).toBe(0);
        await act(async () => router.revalidate());
        expect(sent).toHaveLength(1);
        expect(lookups).toBe(1);
      } finally {
        router.dispose();
      }
    },
  );

  it("shows pending report confirmation without showing a pending reply", async () => {
    const pending = deferred<null>();
    const path = "/account/reviews/rev_one";
    const router = createMemoryRouter(
      [
        {
          path,
          loader: () => ({
            viewerAccountId: "acc_subject",
            review: {
              review_id: "rev_one",
              order_id: "ord_one",
              author_account_id: "acc_author",
              author_role: "buyer",
              subject_account_id: "acc_subject",
              status: "active",
              rating: 5,
              revealed_at: "2026-11-17T00:00:00.000Z",
              held: false,
              feedback_redacted_at: null,
              reply_id: null,
            },
          }),
          action: () => pending.promise,
          element: <AccountReviewRoute />,
        },
      ],
      { initialEntries: [path] },
    );
    try {
      render(
        <ChaseRoot>
          <RouterProvider router={router} />
        </ChaseRoot>,
      );
      const replyLabel = t("reputation.features.reviews.ui.reviewDetailPage.reply.submit");
      await screen.findByRole("button", { name: replyLabel });
      fireEvent.click(
        screen.getByRole("button", { name: t("reputation.features.reviews.ui.reviewReportAction.title") }),
      );
      const formData = new FormData();
      formData.set("intent", "confirm:report-review");
      act(() => void router.navigate(path, { formMethod: "POST", formData }));
      await screen.findByRole("button", { name: t("reputation.features.reviews.ui.reviewReportAction.submitting") });
      expect(screen.getByText(replyLabel)).toBeTruthy();
    } finally {
      await act(async () => pending.resolve(null));
      router.dispose();
    }
  });

  it.each(["committed", "not-observed", "ambiguous", "conflict"] as const)(
    "resolves possible-send loss once to %s without a fresh write",
    async (status) => {
      const write = deferred<{ id: string; version: number }>();
      const observation = deferred<unknown>();
      const send = vi.fn(() => write.promise);
      const lookup = vi.fn(async (id: string, _kind: unknown, _target: string, hash: string) => {
        await observation.promise;
        return {
          schemaVersion: 1,
          mutationKind: "review.reply",
          actorBinding: { accountId: "acc_subject" },
          target: { kind: "review", id: "rev_one" },
          attemptKeyFingerprint: await marketplaceRequestHash([
            "acc_subject",
            "review.reply",
            { kind: "review", id: "rev_one" },
            id,
          ]),
          canonicalRequestHash: hash,
          ownerStatus: status,
          ...(status === "committed" ? { ownerReceipt: { id: "rev_one", version: 4 } } : {}),
        };
      });
      const router = createMemoryRouter([
        {
          id: "review",
          path: "/",
          loader: () => ({}),
          shouldRevalidate: () => false,
          action: async ({ request }) => {
            const formData = await request.formData();
            const result = await runReviewMutation({
              formData,
              kind: "review.reply",
              target: "rev_one",
              request: { reviewId: "rev_one", feedback: "Thanks" },
              send,
              lookup,
              isResponse: () => false,
              code: () => null,
            });
            return "result" in result
              ? { attemptId: String(formData.get("attemptId")), mutationPhase: "succeeded" }
              : result;
          },
          element: (
            <ReviewMutationForm method="post">
              <input name="feedback" defaultValue="Thanks" />
              <button name="intent" value="reply">
                Send
              </button>
            </ReviewMutationForm>
          ),
        },
      ]);
      render(
        <ChaseRoot>
          <RouterProvider router={router} />
        </ChaseRoot>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Send" }));
      await screen.findByText("Submitting");
      await act(async () => write.reject(new Error("response lost")));
      await screen.findByText("Confirming the first result");
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
      await act(async () => observation.resolve(null));
      const title =
        status === "committed"
          ? "Submitted"
          : status === "not-observed"
            ? "Not submitted"
            : status === "conflict"
              ? "This attempt conflicts with the first request."
              : "Result not confirmed. Do not submit again.";
      await screen.findByText(title);
      expect(send).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      if (status === "ambiguous" || status === "conflict") {
        expect(screen.getByRole("status")).toBe(document.activeElement);
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        expect(send).toHaveBeenCalledTimes(1);
      }
      await act(async () => router.revalidate());
      expect(send).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      router.dispose();
    },
  );

  it.each([
    "editing",
    "submitting",
    "confirming",
    "succeeded",
    "failed-safe",
    "ambiguous",
    "conflict",
  ] satisfies ReviewMutationPhase[])("does not append anything when returning to retained %s state", async (phase) => {
    const action = vi.fn();
    const router = createMemoryRouter(
      [
        {
          id: "review",
          path: "/",
          loader: () => ({}),
          action,
          element: (
            <ReviewMutationForm method="post">
              <button>Send</button>
            </ReviewMutationForm>
          ),
        },
      ],
      {
        hydrationData: {
          loaderData: { review: {} },
          actionData: {
            review: {
              attemptId: "retained_review_attempt_0001",
              mutationPhase: phase,
            },
          },
        },
      },
    );
    render(
      <ChaseRoot>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    const button = await screen.findByRole("button", { name: "Send" });
    const disabled = phase !== "editing" && phase !== "failed-safe";
    expect((button as HTMLButtonElement).disabled || Boolean(button.closest("fieldset[disabled]"))).toBe(disabled);
    await act(async () => router.revalidate());
    expect(action).not.toHaveBeenCalled();
    router.dispose();
  });

  it("refuses an invalid identity before sending or resolving", async () => {
    const send = vi.fn();
    const lookup = vi.fn();
    const formData = new FormData();
    formData.set("attemptId", "short");
    expect(
      await runReviewMutation({
        formData,
        kind: "review.reply",
        target: "rev_one",
        request: {},
        send,
        lookup,
        isResponse: () => false,
        code: () => null,
      }),
    ).toMatchObject({ mutationPhase: "failed-safe" });
    expect(send).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not accept a receipt for another attempt fingerprint", async () => {
    const send = vi.fn();
    const formData = new FormData();
    formData.set("attemptId", "review_lookup_identity_0001");
    formData.set("intent", "confirm:reply");
    const lookup = vi.fn(async (_id: string, _kind: unknown, _target: string, hash: string) => ({
      schemaVersion: 1,
      mutationKind: "review.reply",
      actorBinding: { accountId: "acc_subject" },
      target: { kind: "review", id: "rev_one" },
      canonicalRequestHash: hash,
      attemptKeyFingerprint: "a".repeat(64),
      ownerStatus: "committed",
      ownerReceipt: { id: "rev_one", version: 4 },
    }));
    expect(
      await runReviewMutation({
        formData,
        kind: "review.reply",
        target: "rev_one",
        request: { feedback: "Thanks" },
        send,
        lookup,
        isResponse: () => false,
        code: () => null,
      }),
    ).toMatchObject({ mutationPhase: "ambiguous" });
    expect(send).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

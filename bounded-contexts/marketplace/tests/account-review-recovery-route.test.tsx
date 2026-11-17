// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { ReviewMutationForm, type ReviewMutationPhase } from "../features/reviews/ui/review-mutation-form";
import { runReviewMutation } from "../support/route-support/review-mutation-action";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe("review recovery through a real data router", () => {
  it.each(["committed", "not-observed", "ambiguous", "conflict"] as const)(
    "resolves possible-send loss once to %s without a fresh write",
    async (status) => {
      const write = deferred<{ id: string; version: number }>();
      const observation = deferred<unknown>();
      const send = vi.fn(() => write.promise);
      const lookup = vi.fn(async (_id: string, _kind: unknown, _target: string, hash: string) => {
        await observation.promise;
        return {
          schemaVersion: 1, mutationKind: "review.reply", actorBinding: { accountId: "acc_subject" },
          target: { kind: "review", id: "rev_one" }, attemptKeyFingerprint: "a".repeat(64),
          canonicalRequestHash: hash, ownerStatus: status,
          ...(status === "committed" ? { ownerReceipt: { id: "rev_one", version: 4 } } : {}),
        };
      });
      const router = createMemoryRouter([{
        id: "review", path: "/", loader: () => ({}), shouldRevalidate: () => false,
        action: async ({ request }) => {
          const formData = await request.formData();
          const result = await runReviewMutation({
            formData, kind: "review.reply", target: "rev_one", request: { reviewId: "rev_one", feedback: "Thanks" },
            send, lookup, isResponse: () => false, code: () => null,
          });
          return "result" in result ? { attemptId: String(formData.get("attemptId")), mutationPhase: "succeeded" } : result;
        },
        element: <ReviewMutationForm method="post"><input name="feedback" defaultValue="Thanks" /><button name="intent" value="reply">Send</button></ReviewMutationForm>,
      }]);
      render(<ChaseRoot><RouterProvider router={router} /></ChaseRoot>);
      fireEvent.click(await screen.findByRole("button", { name: "Send" }));
      await screen.findByText("Submitting");
      await act(async () => write.reject(new Error("response lost")));
      await screen.findByText("Confirming the first result");
      await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
      await act(async () => observation.resolve(null));
      const title = status === "committed" ? "Submitted" : status === "not-observed" ? "Not submitted" :
        status === "conflict" ? "This attempt conflicts with the first request." : "Result not confirmed. Do not submit again.";
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

  it.each(["editing", "submitting", "confirming", "succeeded", "failed-safe", "ambiguous", "conflict"] satisfies ReviewMutationPhase[])(
    "does not append anything when returning to retained %s state",
    async (phase) => {
      const action = vi.fn();
      const router = createMemoryRouter([{
        id: "review", path: "/", loader: () => ({}), action,
        element: <ReviewMutationForm method="post"><button>Send</button></ReviewMutationForm>,
      }], { hydrationData: { loaderData: { review: {} }, actionData: { review: {
        attemptId: "retained_review_attempt_0001", mutationPhase: phase,
      } } } });
      render(<ChaseRoot><RouterProvider router={router} /></ChaseRoot>);
      const button = await screen.findByRole("button", { name: "Send" });
      const disabled = phase !== "editing" && phase !== "failed-safe";
      expect((button as HTMLButtonElement).disabled || Boolean(button.closest("fieldset[disabled]"))).toBe(disabled);
      await act(async () => router.revalidate());
      expect(action).not.toHaveBeenCalled();
      router.dispose();
    },
  );

  it("refuses an invalid identity before sending or resolving", async () => {
    const send = vi.fn();
    const lookup = vi.fn();
    const formData = new FormData();
    formData.set("attemptId", "short");
    expect(await runReviewMutation({ formData, kind: "review.reply", target: "rev_one", request: {}, send, lookup,
      isResponse: () => false, code: () => null })).toMatchObject({ mutationPhase: "failed-safe" });
    expect(send).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildAuthSessionTransactionalEmailProjectionHandlers,
  buildMagicLinkUrl,
} from "./transactional-email-projector";
import {
  SAME_SITE_TEST_ORIGIN,
  UNSAFE_AUTH_PATHS,
  VALID_AUTH_PATHS,
} from "../../../../support/auth-support/same-site-path.test-support";
import * as sameSitePaths from "../../../../support/auth-support/same-site-path";

async function projectAuthSessionEventToTransactionalEmail(
  outbox: Parameters<typeof buildAuthSessionTransactionalEmailProjectionHandlers>[0],
  deliveryTokens: Parameters<typeof buildAuthSessionTransactionalEmailProjectionHandlers>[1],
  event: never,
) {
  const handlers = buildAuthSessionTransactionalEmailProjectionHandlers(outbox, deliveryTokens);
  await handlers[(event as { type: string }).type]?.(event);
}

describe("auth transactional email projector", () => {
  it.each([...UNSAFE_AUTH_PATHS, ...VALID_AUTH_PATHS])(
    "Auth same-site path caller matrix: queued metadata %j",
    async (path) => {
      const outbox = {
        enqueueNotification: vi.fn(async (_input: { message: { templateData: unknown } }) => undefined),
      };
      const delivery = {
        getMagicLinkDeliveryToken: vi.fn(async () => "synthetic-queued-token"),
        clearMagicLinkDeliveryToken: vi.fn(async () => undefined),
      };
      await projectAuthSessionEventToTransactionalEmail(outbox, delivery, {
        id: "evt_queued",
        type: "auth.magic-link.requested",
        globalPosition: "1",
        trace: { traceId: "queued" },
        timing: { occurredAt: "2026-10-28T00:00:00.000Z", recordedAt: "2026-10-28T00:00:01.000Z" },
        data: {
          tokenId: "cmd_queued",
          userId: "usr_existing",
          email: "buyer@example.test",
          expiresAt: "2026-10-28T00:10:00.000Z",
          origin: SAME_SITE_TEST_ORIGIN,
          landingPath: path,
          returnTo: path,
        },
      } as never);
      const template = outbox.enqueueNotification.mock.calls[0]![0].message.templateData as { magicLink: string };
      const url = new URL(template.magicLink);
      const valid = VALID_AUTH_PATHS.includes(path);
      const expected = new URL(valid ? path : "/sign-in/magic", SAME_SITE_TEST_ORIGIN);
      expect(url.origin).toBe(SAME_SITE_TEST_ORIGIN);
      expect(url.pathname).toBe(expected.pathname);
      expect(url.hash).toBe(expected.hash);
      for (const [key, value] of expected.searchParams) expect(url.searchParams.get(key)).toBe(value);
      expect(url.searchParams.get("token")).toBe("synthetic-queued-token");
      expect(url.searchParams.get("returnTo")).toBe(valid ? path : null);
      expect(delivery.clearMagicLinkDeliveryToken).toHaveBeenCalledWith("cmd_queued");
    },
  );

  it("checks the final magic-link origin before appending a token even if validation regresses", () => {
    const guard = vi.spyOn(sameSitePaths, "getSafeSameSitePath").mockReturnValue("/\\outside.example.test/collect");
    try {
      const url = new URL(buildMagicLinkUrl({ token: "synthetic-final-token", origin: SAME_SITE_TEST_ORIGIN }));
      expect(url.origin).toBe(SAME_SITE_TEST_ORIGIN);
      expect(url.pathname).toBe("/sign-in/magic");
      expect(url.searchParams.get("token")).toBe("synthetic-final-token");
    } finally {
      guard.mockRestore();
    }
  });

  it("preserves trimming of ordinary spaces but rejects controls before trimming", () => {
    const url = new URL(
      buildMagicLinkUrl({
        token: "synthetic-token",
        origin: SAME_SITE_TEST_ORIGIN,
        landingPath: " /sign-in/magic ",
        returnTo: " /account ",
      }),
    );
    expect(url.pathname).toBe("/sign-in/magic");
    expect(url.searchParams.get("returnTo")).toBe("/account");
  });

  it("tokenized links remain same-origin", () => {
    const url = new URL(
      buildMagicLinkUrl({
        token: "synthetic-boundary-token",
        origin: "https://marketplace.example.test",
        landingPath: "/\\outside.example.test/collect",
      }),
    );
    expect(url.origin).toBe("https://marketplace.example.test");
    expect(url.pathname).toBe("/sign-in/magic");
    expect(url.searchParams.get("token")).toBe("synthetic-boundary-token");
  });

  it("enqueues email from auth.magic-link.requested transport events without storing the secret on the event", async () => {
    const outbox = {
      enqueueNotification: vi.fn(async (_input: { message: { templateData: unknown } }) => undefined),
    };
    const deliveryTokens = {
      getMagicLinkDeliveryToken: vi.fn(async () => "magic_token"),
      clearMagicLinkDeliveryToken: vi.fn(async () => undefined),
    };

    await projectAuthSessionEventToTransactionalEmail(outbox, deliveryTokens, {
      id: "evt_1",
      type: "auth.magic-link.requested",
      globalPosition: "1",
      trace: { traceId: "req_1" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        tokenId: "cmd_1",
        userId: null,
        email: "buyer@example.com",
        expiresAt: "2026-04-02T00:10:00.000Z",
        origin: "https://marketplace.chasesets.com",
        landingPath: "/sign-in/magic",
        returnTo: "/account/listings",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(deliveryTokens.clearMagicLinkDeliveryToken).toHaveBeenCalledWith("cmd_1");
    expect(outbox.enqueueNotification.mock.calls[0]?.[0].message.templateData).toEqual({
      magicLink: "https://marketplace.chasesets.com/sign-in/magic?token=magic_token&returnTo=%2Faccount%2Flistings",
    });
  });
});

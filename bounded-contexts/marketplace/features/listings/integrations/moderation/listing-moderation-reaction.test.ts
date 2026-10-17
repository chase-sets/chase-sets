import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { BcContextManifest } from "@chase-sets/bounded-context-module";
import { buildListingModerationReactionHandlers } from "./listing-moderation-reaction";

const directiveType = "platform-operations.reported-content.listing-removal-directed";
const reactionName = "marketplace-listing-moderation-reaction";
const manifest = JSON.parse(
  readFileSync(new URL("../../../../context.json", import.meta.url), "utf8"),
) as BcContextManifest;
function directive() {
  return {
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
    trace: {},
    data: {
      actionId: createId("rca"),
      listingId: createId("lst"),
      operatorUserId: null,
      directedAt: "2026-10-06T09:00:00.000-05:00",
    },
  } as const;
}

describe("listing moderation reaction", () => {
  it("rejects malformed directives before dispatch rather than accepting poisoned input", async () => {
    const event = directive();
    const operatorUnlistListing = vi.fn();
    const handler = buildListingModerationReactionHandlers({ operatorUnlistListing })[directiveType]!;
    for (const data of [
      { ...event.data, actionId: "rca_invalid" },
      { ...event.data, extra: true },
      { ...event.data, directedAt: "2026-10-06" },
    ]) {
      await expect(handler({ ...event, data } as never)).rejects.toThrow();
    }
    expect(operatorUnlistListing).not.toHaveBeenCalled();
  });

  it("first activation manifest accepts only new directives, not historical audits", () => {
    const declaration = manifest.eventReactions?.find(({ reactionName: name }) => name === reactionName);
    expect(declaration).toEqual({
      sourceContextName: "platform-operations",
      reactionName,
      subscriptionVersion: 1,
      filterToEventTypes: true,
      eventTypes: [directiveType],
      order: 95,
      reactionHandlerSetNames: [reactionName],
      idempotencyPolicy: "idempotent-command-dispatch",
      retryPolicy: "retry-from-last-checkpoint",
      failurePolicy: "surface-as-reaction-failure",
    });
    expect(manifest.projectionGroups?.find(({ projectionName }) => projectionName === reactionName)).toEqual({
      projectionName: reactionName,
      handlerKind: "reaction",
      sourceContextNames: ["platform-operations"],
      ownedTables: [],
      includeInBootstrap: false,
      resetStrategy: "replay-only",
    });
    expect(Object.keys(buildListingModerationReactionHandlers({ operatorUnlistListing: vi.fn() }))).toEqual([
      directiveType,
    ]);
  });

  it("dispatches the source action and exact time with one minted enforcement identity", async () => {
    const event = directive();
    const operatorUnlistListing = vi.fn().mockResolvedValue(undefined);
    await buildListingModerationReactionHandlers({ operatorUnlistListing })[directiveType]!(event as never);
    expect(operatorUnlistListing).toHaveBeenCalledTimes(1);
    expect(operatorUnlistListing).toHaveBeenCalledWith(
      {
        listingId: event.data.listingId,
        sourceActionId: event.data.actionId,
        listingEnforcementActionId: expect.stringMatching(/^lea_[0-9A-HJKMNP-TV-Z]{26}$/),
        recordedAt: event.data.directedAt,
      },
      { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
    );
  });

  it("retry boundary reloads only through a second command call with the same identity and time", async () => {
    const conflict = { code: "concurrency_conflict" };
    const operatorUnlistListing = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(undefined);
    await buildListingModerationReactionHandlers({ operatorUnlistListing })[directiveType]!(directive() as never);
    expect(operatorUnlistListing).toHaveBeenCalledTimes(2);
    expect(operatorUnlistListing.mock.calls[1]).toEqual(operatorUnlistListing.mock.calls[0]);
  });

  it("retry boundary propagates the second typed conflict unchanged after exactly two calls", async () => {
    const second = { code: "concurrency_conflict", marker: "second" };
    const operatorUnlistListing = vi
      .fn()
      .mockRejectedValueOnce({ code: "concurrency_conflict" })
      .mockRejectedValueOnce(second);
    await expect(
      buildListingModerationReactionHandlers({ operatorUnlistListing })[directiveType]!(directive() as never),
    ).rejects.toBe(second);
    expect(operatorUnlistListing).toHaveBeenCalledTimes(2);
    expect(operatorUnlistListing.mock.calls[1]).toEqual(operatorUnlistListing.mock.calls[0]);
  });

  it.each([new Error("concurrency_conflict"), { code: "other" }, null])(
    "does not retry other errors: %s",
    async (error) => {
      const operatorUnlistListing = vi.fn().mockRejectedValue(error);
      await expect(
        buildListingModerationReactionHandlers({ operatorUnlistListing })[directiveType]!(directive() as never),
      ).rejects.toBe(error);
      expect(operatorUnlistListing).toHaveBeenCalledTimes(1);
    },
  );

  it("enrolls the new DB proof once and excludes it from unit tests without dropping incumbent cases", () => {
    for (const [context, file, incumbent] of [
      [
        "marketplace",
        "features/listings/tests/listing-moderation-reaction.db.test.ts",
        "features/listings/tests/listing-enforcement.db.test.ts",
      ],
      [
        "platform-operations",
        "features/reported-content/tests/listing-removal-directive.db.test.ts",
        "features/reported-content/read-model/projection.db.test.ts",
      ],
    ]) {
      const { scripts } = JSON.parse(
        readFileSync(new URL(`../../../../../${context}/package.json`, import.meta.url), "utf8"),
      );
      expect(scripts["test:db"].split(/\s+/).filter((token: string) => token === file)).toHaveLength(1);
      expect(scripts["test:unit"].split(/\s+/).filter((token: string) => token === file)).toHaveLength(1);
      expect(scripts["test:unit"]).toContain(`--exclude ${file}`);
      expect(scripts["test:db"]).toContain(incumbent);
    }
  });
});

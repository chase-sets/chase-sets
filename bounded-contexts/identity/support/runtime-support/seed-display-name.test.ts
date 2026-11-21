import { describe, expect, it, vi } from "vitest";
import type { BcSeedOptions } from "@chase-sets/bounded-context-module";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  decideAccount,
  evolveAccount,
  initialAccountState,
  type AccountEvent,
} from "../../features/accounts/domain/domain";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import { seedIdentityDatabase } from "./seed";
import { createIdentityServices } from "./services";

vi.mock("./services", () => ({ createIdentityServices: vi.fn() }));

describe("display-name seed entrypoints", () => {
  it.each(["scenario-seed", "representative-commerce-state", "admin-qa-actor-fixtures"] as const)(
    "%s creates safe profiles and refuses a planted unsafe value before append for every Account command",
    async (profile) => {
      const memory = createInMemoryEventStore();
      const { commandHandler } = createAggregateCommandHandler({
        eventStore: memory.eventStore,
        codec: createPassthroughDomainEventCodec<AccountEvent>(),
        initialState: () => initialAccountState,
        decide: decideAccount,
        evolve: evolveAccount,
      });
      const captured = vi.fn(commandHandler);
      const background = { commandHandler: vi.fn(), getUserState: vi.fn(), getMembershipState: vi.fn() };
      vi.mocked(createIdentityServices).mockReturnValue({
        db: { query: vi.fn(async () => ({ rows: [] })) },
        auth: { hashSecret: vi.fn(() => "a".repeat(64)) },
        accounts: { commandHandler: captured, getAccountState: vi.fn() },
        users: background,
        memberships: background,
        invitations: background,
        apiKeys: background,
        shippingAddresses: { commandHandler: vi.fn(), getShippingAddressBookState: vi.fn() },
      } as unknown as ReturnType<typeof createIdentityServices>);
      const options = { enabledDataProfiles: [profile] } satisfies BcSeedOptions;
      await seedIdentityDatabase({} as never, undefined, options);
      const createCommands = captured.mock.calls.flatMap(([input]) =>
        input.command.type === "CreateAccount" ? [input.command] : [],
      );
      expect(createCommands.length).toBeGreaterThan(0);
      expect(memory.allEvents.filter((event) => event.eventType === "identity.account.created")).toHaveLength(
        createCommands.length,
      );
      const before = memory.allEvents.length;
      for (const command of createCommands) {
        await expect(
          commandHandler({
            streamId: `identity.account-unsafe-${command.accountId}`,
            context: createIdentityBootstrapContext(),
            command: { ...command, displayName: "account-profile-marker-scan http://test.example" },
          }),
        ).rejects.toThrow(/^text_unsafe_link$/);
      }
      expect(memory.allEvents).toHaveLength(before);
    },
  );
});

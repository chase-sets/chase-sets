import { describe, expect, it } from "vitest";
import { listingAuthorityConformance } from "@chase-sets/platform-runtime/listing-authority-conformance";
import { AuthSessionMutationPendingError } from "./listing-authority";
import { authFixture } from "./listing-authority-test-support";

describe("actual Auth source shared conformance with a distinct consumer store", () => {
  // Source-only protocol proof, not a complete business authorization or Identity proof.
  listingAuthorityConformance(it, () => authFixture({ sourceOnly: true }));

  it("canonical setup and revoke retain distinct writer journals and both session events", async () => {
    const f = await authFixture({ sourceOnly: true });
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    const count = (kind: string) =>
      [...f.authMemory.streams.keys()].filter((id) => id.startsWith(`auth.listing-authority-${kind}-`)).length;
    expect(count("mutation")).toBe(2);
    expect(count("write")).toBe(1);
    await f.invalidate();
    expect(count("mutation")).toBe(3);
    expect(count("write")).toBe(2);
    expect((await f.authStore.readStream({ streamId: f.streamId })).map((event) => event.eventType)).toEqual([
      "auth.session.started",
      "auth.session.revoked",
    ]);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });

  it("r11 retains pending mutation identity and active authority after paired history loss", async () => {
    const f = await authFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grants = await f.prepareAuthorities(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, grants, { accepted: true });
    const resource = [...f.authMemory.streams.keys()].find((id) => id.startsWith("auth.listing-authority-resource-"))!;
    const identity = resource.slice("auth.listing-authority-resource-".length);
    f.authMemory.streams.delete(resource);
    f.authMemory.streams.delete(`auth.listing-authority-integrity-${identity}`);
    expect(
      f.authMemory.streams.get(`auth.listing-authority-registration-resource-${identity}`)?.length,
    ).toBeGreaterThan(0);
    f.restart();
    const pending = await f.sessions
      .commandHandler({ streamId: f.streamId, context: f.audit, command: { type: "RevokeSession" } })
      .catch((error: unknown) => error);
    expect(pending).toBeInstanceOf(AuthSessionMutationPendingError);
    const mutationId = (pending as AuthSessionMutationPendingError).mutationId;
    expect(mutationId).toMatch(/^session-write-/);
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
    expect((await f.fence.inspect(operation)).status).toBe("pending");
    await expect(f.sessions.listingAuthority.source.settle(operation)).rejects.toThrow();
    await expect(f.sessions.listingAuthority.resumeMutation(mutationId, f.audit)).rejects.toMatchObject({ mutationId });
    expect((await f.sessions.getSessionState(f.sessionId))?.status).toBe("active");
    // A retained executor is safe only because the source mutation did not become effective.
    await f.consumerStore.appendToStreams!(terminal);
    expect((await f.fence.inspect(operation)).status).toBe("committed");
  });
});

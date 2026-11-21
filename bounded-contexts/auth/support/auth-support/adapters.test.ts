import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAuthSecretAdapters } from "./adapters";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, scrypt: vi.fn(original.scrypt), timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

const adapters = createAuthSecretAdapters();

function legacySha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Build a valid scrypt PHC string with arbitrary (e.g. weaker) cost params. */
function scryptPhc(password: string, cost: { N: number; r: number; p: number }): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { ...cost, maxmem: 256 * cost.N * cost.r * cost.p + 1024 * 1024 });
  return `scrypt$N=${cost.N},r=${cost.r},p=${cost.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

describe("password KDF adapters", () => {
  it("hashes into a self-describing scrypt PHC string (algorithm + params + salt embedded)", async () => {
    const stored = await adapters.hashPassword("correct horse battery staple");

    const parts = stored.split("$");
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toMatch(/^N=\d+,r=\d+,p=\d+$/);
    // salt and hash are non-empty base64, distinct segments
    expect(parts).toHaveLength(4);
    expect(parts[2]!.length).toBeGreaterThan(0);
    expect(parts[3]!.length).toBeGreaterThan(0);
    // A legacy bare SHA-256 could never be confused with this.
    expect(stored).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("never stores the plaintext or a fast unsalted digest of the password", async () => {
    const password = "hunter2-hunter2";
    const stored = await adapters.hashPassword(password);

    expect(stored).not.toContain(password);
    expect(stored).not.toContain(legacySha256(password));
  });

  it("verifies a password round-trip", async () => {
    const stored = await adapters.hashPassword("s3cret-passphrase");

    await expect(adapters.verifyPassword("s3cret-passphrase", stored)).resolves.toEqual({ valid: true });
  });

  it("produces DIFFERENT hashes for the SAME password (per-credential random salt)", async () => {
    const [a, b] = await Promise.all([
      adapters.hashPassword("shared-password"),
      adapters.hashPassword("shared-password"),
    ]);

    expect(a).not.toBe(b);
    // Both still verify — proving equality of hashes is NOT how verification works.
    await expect(adapters.verifyPassword("shared-password", a)).resolves.toEqual({ valid: true });
    await expect(adapters.verifyPassword("shared-password", b)).resolves.toEqual({ valid: true });
  });

  it("rejects a wrong password", async () => {
    const stored = await adapters.hashPassword("right-password");

    await expect(adapters.verifyPassword("wrong-password", stored)).resolves.toEqual({ valid: false });
  });

  it("round-trips the cost parameters from the stored string", async () => {
    const stored = await adapters.hashPassword("params-check");
    const params = stored.split("$")[1]!;

    // The verify path re-derives using the params encoded in the stored hash,
    // so a hash carrying its own (matching) current params must verify without
    // requesting a rehash.
    expect(params).toBe("N=32768,r=8,p=1");
    await expect(adapters.verifyPassword("params-check", stored)).resolves.toEqual({ valid: true });
  });

  it("re-hashes (upgrades) when the stored scrypt cost is weaker than current defaults", async () => {
    // A credential hashed with an older, cheaper cost still verifies, but the
    // verify returns an upgraded hash at the current cost to persist.
    const weak = scryptPhc("upgrade-me", { N: 2 ** 12, r: 8, p: 1 });

    const result = await adapters.verifyPassword("upgrade-me", weak);

    expect(result.valid).toBe(true);
    expect(result.upgradedHash).toBeDefined();
    expect(result.upgradedHash!.split("$")[1]).toBe("N=32768,r=8,p=1");
    await expect(adapters.verifyPassword("upgrade-me", result.upgradedHash!)).resolves.toEqual({ valid: true });
  });

  it("rejects a malformed / truncated PHC string instead of throwing", async () => {
    await expect(adapters.verifyPassword("x", "scrypt$N=32768,r=8,p=1$only-three-parts")).resolves.toEqual({
      valid: false,
    });
    await expect(adapters.verifyPassword("x", "scrypt$garbage$c2FsdA==$aGFzaA==")).resolves.toEqual({ valid: false });
  });

  it("derives once at current cost for every rejected stored-hash shape", async () => {
    const modern = await adapters.hashPassword("different-password");
    const rejected = [
      modern,
      "scrypt$N=32768,r=8,p=1$truncated",
      modern.replace("N=32768", "N=1"),
      modern.replace("$N=", "$N=garbage"),
      modern.replace(/(\$[^$]+)$/, "$1!"),
      legacySha256("different-password"),
      "unknown",
      null,
    ];
    for (const storedHash of rejected) {
      vi.mocked(scrypt).mockClear();
      await expect(adapters.verifyPassword("guessed-password", storedHash)).resolves.toEqual({ valid: false });
      expect(scrypt).toHaveBeenCalledExactlyOnceWith(
        "guessed-password",
        expect.any(Buffer),
        64,
        expect.objectContaining({ N: 32768, r: 8, p: 1 }),
        expect.any(Function),
      );
    }
  });

  describe("legacy SHA-256 migration", () => {
    it("verifies a legacy bare SHA-256 hash AND returns an upgraded scrypt hash to persist", async () => {
      const legacy = legacySha256("legacy-user-password");

      const result = await adapters.verifyPassword("legacy-user-password", legacy);

      expect(result.valid).toBe(true);
      expect(result.upgradedHash).toBeDefined();
      expect(result.upgradedHash).toMatch(/^scrypt\$/);
      // The upgraded hash is a real, verifiable scrypt hash for the same password.
      await expect(adapters.verifyPassword("legacy-user-password", result.upgradedHash!)).resolves.toEqual({
        valid: true,
      });
    });

    it("rejects a wrong password against a legacy hash without upgrading", async () => {
      const legacy = legacySha256("the-real-password");

      const result = await adapters.verifyPassword("guessed-password", legacy);

      expect(result).toEqual({ valid: false });
    });

    it("does not request a rehash for a current-generation scrypt hash", async () => {
      const stored = await adapters.hashPassword("already-modern");

      const result = await adapters.verifyPassword("already-modern", stored);

      expect(result.upgradedHash).toBeUndefined();
    });
  });

  it("keeps hashSecret (sha256) available and unchanged for opaque server tokens", () => {
    // Token hashing MUST remain the fast unsalted digest — passwords and tokens
    // are deliberately separated.
    expect(adapters.hashSecret("opaque-token")).toBe(legacySha256("opaque-token"));
    expect(adapters.verifySecret("opaque-token", legacySha256("opaque-token"))).toBe(true);
  });

  it.each(["opaque-token", "different-token"])("compares the 32-byte digest of %s in constant time", (token) => {
    const stored = legacySha256("opaque-token");
    vi.mocked(timingSafeEqual).mockClear();

    expect(adapters.verifySecret(token, stored)).toBe(token === "opaque-token");
    expect(timingSafeEqual).toHaveBeenCalledExactlyOnceWith(
      Buffer.from(legacySha256(token), "hex"),
      Buffer.from(stored, "hex"),
    );
  });

  it.each(["a".repeat(62), "g".repeat(64), `${"a".repeat(63)}\n`])("rejects a malformed secret digest", (stored) => {
    vi.mocked(timingSafeEqual).mockClear();

    expect(adapters.verifySecret("opaque-token", stored)).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });
});

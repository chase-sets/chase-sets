#!/usr/bin/env node
import process from "node:process";

import { createFilesystemObjectStorage, createS3ObjectStorage } from "../infrastructure/object-storage/index.ts";
import {
  OBSERVATION_PACK_DECISION_LINK,
  OBSERVATION_PACK_MANIFEST_PATH,
  recordObservationPackAcceptance,
  sha256,
  verifyObservationPack,
  writeObservationPack,
  writeObservationPackAcceptance,
  type ObservationPackBundle,
  type ObservationPackIdentityInput,
  type ObservationPackObjectStorage,
} from "../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";
import { captureObservationPack as captureObservationPackFromAdapter } from "../bounded-contexts/catalog/features/source-observations/api/observation-pack-capture.ts";
import {
  getActiveCatalogProviderIntegrationProfileVersion,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts";
import {
  createTcgdexProviderAdapter,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../bounded-contexts/catalog/features/source-observations/api/provider-adapters/tcgdex.ts";
import {
  createScryfallProviderAdapter,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../bounded-contexts/catalog/features/source-observations/api/provider-adapters/scryfall.ts";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../bounded-contexts/catalog/features/source-observations/api/provider-adapters/scrydex-one-piece.ts";
import {
  createLorcanajsonProviderAdapter,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../bounded-contexts/catalog/features/source-observations/api/provider-adapters/lorcanajson.ts";
import type {
  ProviderAdapter,
  ProviderImportScope,
} from "../bounded-contexts/catalog/features/source-observations/api/provider-adapters/provider-adapter.ts";

const DEFAULT_SPACE_BUCKET = "cs-dev-seed-packs";
const DEFAULT_SPACE_REGION = "nyc3";
const DEFAULT_SPACE_ENDPOINT = "https://nyc3.digitaloceanspaces.com";

export type ObservationPackCapturePresetKey =
  | "pokemon-prismatic-evolutions"
  | "mtg-time-spiral"
  | "one-piece-romance-dawn"
  | "lorcana-the-first-chapter";

type ObservationPackCapturePreset = Readonly<{
  key: ObservationPackCapturePresetKey;
  packId: string;
  providerKey: string;
  profileKey: string;
  unitKey: string;
  scope: ProviderImportScope;
  identity: Omit<ObservationPackIdentityInput, "integrationProfileKey" | "integrationProfileVersion" | "ingestionUnit">;
}>;

export const observationPackCapturePresets: Readonly<
  Record<ObservationPackCapturePresetKey, ObservationPackCapturePreset>
> = {
  "pokemon-prismatic-evolutions": {
    key: "pokemon-prismatic-evolutions",
    packId: "tcgdex-pokemon-prismatic-evolutions-en",
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    scope: {
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { languageCode: "en", seriesId: "sv", setId: "sv08.5" },
    },
    identity: {
      productLineKey: "pokemon-tcg",
      productLineDisplayName: "Pokemon TCG",
      setKind: "expansion",
      setExternalId: "sv08.5",
      setDisplayName: "Prismatic Evolutions",
      providerKey: "tcgdex",
      language: "en",
      scopeKey: "expansion",
      scopeCoordinates: { languageCode: "en", seriesId: "sv", setId: "sv08.5" },
    },
  },
  "mtg-time-spiral": {
    key: "mtg-time-spiral",
    packId: "scryfall-mtg-time-spiral-en",
    providerKey: "scryfall",
    profileKey: "mtg-card-print-reference-data",
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scope: {
      unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set",
      values: { languageCode: "en", setCode: "tsp" },
    },
    identity: {
      productLineKey: "magic-the-gathering",
      productLineDisplayName: "Magic: The Gathering",
      setKind: "set",
      setExternalId: "tsp",
      setDisplayName: "Time Spiral",
      providerKey: "scryfall",
      language: "en",
      scopeKey: "set",
      scopeCoordinates: { languageCode: "en", setCode: "tsp" },
    },
  },
  "one-piece-romance-dawn": {
    key: "one-piece-romance-dawn",
    packId: "scrydex-one-piece-romance-dawn-en",
    providerKey: "scrydex",
    profileKey: "one-piece-card-print-source-observation",
    unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    scope: {
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { languageCode: "en", expansionId: "op-01" },
    },
    identity: {
      productLineKey: "one-piece-card-game",
      productLineDisplayName: "One Piece Card Game",
      setKind: "set",
      setExternalId: "op-01",
      setDisplayName: "Romance Dawn",
      providerKey: "scrydex",
      language: "en",
      scopeKey: "expansion",
      scopeCoordinates: { languageCode: "en", expansionId: "op-01" },
    },
  },
  "lorcana-the-first-chapter": {
    key: "lorcana-the-first-chapter",
    packId: "lorcanajson-lorcana-the-first-chapter-en",
    providerKey: "lorcanajson",
    profileKey: "lorcana-card-reference-data",
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    scope: {
      unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set",
      values: { languageCode: "en", setCode: "1" },
    },
    identity: {
      productLineKey: "disney-lorcana",
      productLineDisplayName: "Disney Lorcana",
      setKind: "set",
      setExternalId: "1",
      setDisplayName: "The First Chapter",
      providerKey: "lorcanajson",
      language: "en",
      scopeKey: "set",
      scopeCoordinates: { languageCode: "en", setCode: "1" },
    },
  },
};

export async function captureObservationPack(input: {
  preset: ObservationPackCapturePreset;
  profileVersion: CatalogProviderIntegrationProfileVersionRecord;
  adapter: ProviderAdapter;
  packVersion: string;
  capturedAt: string;
  fetch?: typeof globalThis.fetch;
  credentialValues?: readonly string[];
}): Promise<ObservationPackBundle> {
  return captureObservationPackFromAdapter({
    definition: input.preset,
    profile: input.profileVersion,
    adapter: input.adapter,
    packVersion: input.packVersion,
    capturedAt: input.capturedAt,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    credentialValues: input.credentialValues,
  });
}

export async function runCatalogObservationPackCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<number> {
  try {
    const command = argv[0];
    if (command === "capture") {
      const options = parseCaptureOptions(argv.slice(1));
      const preset = observationPackCapturePresets[options.preset];
      const profileVersion = requireActiveProfileVersion(preset);
      const adapter = createConfiguredAdapter(preset, profileVersion, env);
      const target = createTarget(options.target, options.outputDir, env);
      const bundle = await captureObservationPackFromAdapter({
        definition: preset,
        profile: profileVersion,
        adapter,
        packVersion: options.packVersion,
        capturedAt: options.capturedAt,
        credentialValues: credentialValues(env),
      });
      const prefix =
        target.kind === "local"
          ? `${preset.packId}/${options.packVersion}`
          : `observation-packs/${preset.packId}/${options.packVersion}`;
      const write = await writeObservationPack({ storage: target.storage, prefix, bundle });
      const readBack = await verifyObservationPack({
        storage: target.storage,
        manifestKey: write.manifestKey,
        requireAccepted: false,
      });
      const readBackManifest = await target.storage.getObject(write.manifestKey);
      if (!readBack.valid || !readBackManifest || sha256(readBackManifest.body) !== write.manifestHash) {
        throw new Error("Observation Pack post-upload read-back verification failed.");
      }
      writeSafeOutput(output, {
        command: "capture",
        status: "captured",
        providerKey: preset.providerKey,
        target: target.kind,
        readBackVerified: true,
        replayEligible: false,
        counts: readBack.counts,
        manifestKey: write.manifestKey,
      });
      return 0;
    }

    if (command === "accept") {
      const options = parseAcceptOptions(argv.slice(1));
      const target = createAcceptanceTarget(options, env);
      const before = await verifyObservationPack({
        storage: target.storage,
        manifestKey: target.manifestKey,
        requireAccepted: false,
      });
      if (!before.valid || !before.manifest) {
        throw new Error("Observation Pack must pass captured verification before acceptance.");
      }
      const accepted = recordObservationPackAcceptance(before.manifest, {
        acceptedBy: options.acceptedBy,
        acceptedAt: options.acceptedAt,
        decisionLink: options.decisionLink,
      });
      const write = await writeObservationPackAcceptance({
        storage: target.storage,
        manifestKey: target.manifestKey,
        manifest: accepted,
      });
      const after = await verifyObservationPack({
        storage: target.storage,
        manifestKey: target.manifestKey,
        requireAccepted: true,
      });
      const readBackManifest = await target.storage.getObject(target.manifestKey);
      if (
        !after.valid ||
        !after.replayEligible ||
        !readBackManifest ||
        sha256(readBackManifest.body) !== write.manifestHash
      ) {
        throw new Error("Accepted Observation Pack post-upload read-back verification failed.");
      }
      writeSafeOutput(output, {
        command: "accept",
        status: "accepted",
        target: target.kind,
        readBackVerified: true,
        replayEligible: true,
        counts: after.counts,
        manifestKey: target.manifestKey,
      });
      return 0;
    }

    throw new Error("Observation Pack command must be capture or accept.");
  } catch {
    writeSafeOutput(output, {
      command: "observation-pack",
      status: "blocked",
      classification: "observation-pack-command-failed",
    });
    return 1;
  }
}

function requireActiveProfileVersion(
  preset: ObservationPackCapturePreset,
): CatalogProviderIntegrationProfileVersionRecord {
  const profileVersion = getActiveCatalogProviderIntegrationProfileVersion(preset.providerKey, {
    profileKey: preset.profileKey,
  });
  if (!profileVersion || !profileVersion.executableMappingContract) {
    throw new Error("The selected provider profile is not active with an executable mapping contract.");
  }
  return profileVersion;
}

function createConfiguredAdapter(
  preset: ObservationPackCapturePreset,
  profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  env: NodeJS.ProcessEnv,
): ProviderAdapter {
  switch (preset.providerKey) {
    case "tcgdex":
      return createTcgdexProviderAdapter({
        loadActiveProfileVersion: async () => profileVersion,
        fetch: globalThis.fetch,
      });
    case "scryfall":
      return createScryfallProviderAdapter({ profileVersion: profileVersion.profileVersion, fetch: globalThis.fetch });
    case "scrydex":
      return createScrydexOnePieceProviderAdapter({
        profileVersion: profileVersion.profileVersion,
        credentials: { apiKey: env.SCRYDEX_API_KEY, teamId: env.SCRYDEX_TEAM_ID },
        fetch: globalThis.fetch,
      });
    case "lorcanajson":
      return createLorcanajsonProviderAdapter({
        profileVersion: profileVersion.profileVersion,
        fetch: globalThis.fetch,
      });
    default:
      throw new Error("Unsupported Observation Pack provider preset.");
  }
}

function createTarget(
  target: "local" | "space",
  outputDir: string | null,
  env: NodeJS.ProcessEnv,
): Readonly<{ kind: "local" | "space"; storage: ObservationPackObjectStorage }> {
  if (target === "local") {
    if (!outputDir) {
      throw new Error("Local Observation Pack capture requires --output-dir.");
    }
    return {
      kind: "local",
      storage: createFilesystemObjectStorage({ rootDir: outputDir, publicBaseUrl: "https://local.invalid/private" }),
    };
  }
  return { kind: "space", storage: createSpaceStorage(env) };
}

function createAcceptanceTarget(
  options: ReturnType<typeof parseAcceptOptions>,
  env: NodeJS.ProcessEnv,
): Readonly<{ kind: "local" | "space"; storage: ObservationPackObjectStorage; manifestKey: string }> {
  if (options.target === "local") {
    if (!options.packDir) {
      throw new Error("Local Observation Pack acceptance requires --pack-dir.");
    }
    return {
      kind: "local",
      storage: createFilesystemObjectStorage({
        rootDir: options.packDir,
        publicBaseUrl: "https://local.invalid/private",
      }),
      manifestKey: OBSERVATION_PACK_MANIFEST_PATH,
    };
  }
  if (!options.manifestKey) {
    throw new Error("Space Observation Pack acceptance requires --manifest-key.");
  }
  return { kind: "space", storage: createSpaceStorage(env), manifestKey: options.manifestKey };
}

function createSpaceStorage(env: NodeJS.ProcessEnv): ObservationPackObjectStorage {
  const accessKeyId = requiredEnv(env, "SEED_PACKS_SPACES_ACCESS_ID");
  const secretAccessKey = requiredEnv(env, "SEED_PACKS_SPACES_SECRET_KEY");
  const endpoint = env.SEED_PACKS_SPACES_ENDPOINT?.trim() || DEFAULT_SPACE_ENDPOINT;
  const bucket = env.SEED_PACKS_SPACES_BUCKET?.trim() || DEFAULT_SPACE_BUCKET;
  const region = env.SEED_PACKS_SPACES_REGION?.trim() || DEFAULT_SPACE_REGION;
  return createS3ObjectStorage({
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: `${endpoint.replace(/\/$/, "")}/${bucket}`,
  });
}

function parseCaptureOptions(argv: readonly string[]): Readonly<{
  preset: ObservationPackCapturePresetKey;
  target: "local" | "space";
  outputDir: string | null;
  packVersion: string;
  capturedAt: string;
}> {
  assertKnownOptions(argv, ["--preset", "--target", "--output-dir", "--pack-version", "--captured-at"]);
  const preset = requiredOption(argv, "--preset") as ObservationPackCapturePresetKey;
  if (!(preset in observationPackCapturePresets)) {
    throw new Error("Observation Pack capture preset is not supported.");
  }
  const target = (readOption(argv, "--target") ?? "local") as "local" | "space";
  if (target !== "local" && target !== "space") {
    throw new Error("Observation Pack capture target must be local or space.");
  }
  const capturedAt = readOption(argv, "--captured-at") ?? new Date().toISOString();
  return {
    preset,
    target,
    outputDir: readOption(argv, "--output-dir"),
    packVersion: readOption(argv, "--pack-version") ?? defaultPackVersion(capturedAt),
    capturedAt,
  };
}

function parseAcceptOptions(argv: readonly string[]): Readonly<{
  target: "local" | "space";
  packDir: string | null;
  manifestKey: string | null;
  acceptedBy: string;
  acceptedAt: string;
  decisionLink: string;
}> {
  assertKnownOptions(argv, [
    "--target",
    "--pack-dir",
    "--manifest-key",
    "--accepted-by",
    "--accepted-at",
    "--decision-link",
  ]);
  const target = (readOption(argv, "--target") ?? "local") as "local" | "space";
  if (target !== "local" && target !== "space") {
    throw new Error("Observation Pack acceptance target must be local or space.");
  }
  return {
    target,
    packDir: readOption(argv, "--pack-dir"),
    manifestKey: readOption(argv, "--manifest-key"),
    acceptedBy: requiredOption(argv, "--accepted-by"),
    acceptedAt: readOption(argv, "--accepted-at") ?? new Date().toISOString(),
    decisionLink: readOption(argv, "--decision-link") ?? OBSERVATION_PACK_DECISION_LINK,
  };
}

function assertKnownOptions(argv: readonly string[], known: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const name = argument.split("=", 1)[0] ?? argument;
    if (!known.includes(name)) {
      throw new Error("Observation Pack command received an unsupported option.");
    }
    if (!argument.includes("=")) {
      index += 1;
      if (index >= argv.length || argv[index]?.startsWith("--")) {
        throw new Error("Observation Pack command option is missing its value.");
      }
    }
  }
}

function readOption(argv: readonly string[], name: string): string | null {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1).trim() || null;
  }
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() || null : null;
}

function requiredOption(argv: readonly string[], name: string): string {
  const value = readOption(argv, name);
  if (!value) {
    throw new Error("Observation Pack command is missing a required option.");
  }
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error("Observation Pack Space credentials are not configured.");
  }
  return value;
}

function credentialValues(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    env.SCRYDEX_API_KEY,
    env.SCRYDEX_TEAM_ID,
    env.SEED_PACKS_SPACES_ACCESS_ID,
    env.SEED_PACKS_SPACES_SECRET_KEY,
  ].flatMap((value) => (value?.trim() ? [value.trim()] : []));
}

function defaultPackVersion(capturedAt: string): string {
  return `v1-${capturedAt.replace(/[-:.]/g, "")}`;
}

function writeSafeOutput(output: Pick<NodeJS.WriteStream, "write">, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

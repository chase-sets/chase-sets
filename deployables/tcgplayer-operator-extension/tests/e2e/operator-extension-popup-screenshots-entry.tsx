import { createRoot } from "react-dom/client";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import "@chase-sets/design-system/styles.css";
import { OperatorExtensionPopup } from "@chase-sets/catalog/features/operator-session/ui/extension-popup/popup";

const state = new URLSearchParams(location.search).get("state");
const request = async (id: string) => {
  if (state === "loading") return new Promise<never>(() => undefined);
  if (state === "error")
    return {
      ok: false as const,
      status: 503,
      contentClass: "unknown" as const,
      bytes: 0,
      body: null,
      code: "http-not-success" as const,
    };
  return {
    ok: true as const,
    status: 200,
    contentClass: "json" as const,
    bytes: 100,
    body: {
      errors: [],
      results: [
        {
          setNameId: 1,
          categoryId: Number(id),
          name: "Synthetic Set",
          cleanSetName: "Synthetic Set",
          urlName: "synthetic-set",
          abbreviation: "SYN",
          releaseDate: "2026-01-01",
          isSupplemental: false,
          active: true,
        },
      ],
    },
  };
};

createRoot(document.getElementById("root")!).render(
  <ChaseRoot>
    <OperatorExtensionPopup
      request={async () => ({
        paired: false,
        state: "unpaired",
        lastOutcome: null,
        lastPushedAt: null,
        serverRevision: 0,
      })}
      setNameRequest={request}
      copyProbeReport={async () => undefined}
      extensionVersion="0.1.0"
      buildCommit="synthetic-screenshot"
      browserMajor="synthetic-browser"
    />
  </ChaseRoot>,
);

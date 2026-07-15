// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogMergeCandidateEditForm } from "./candidate-edit-form";
import type {
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";

afterEach(cleanup);

function readModel(): CatalogPrimaryWorkbenchReadModel {
  return {
    routeContext: parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=tcgdex",
    ),
    readiness: { rbacAllowed: true, blockers: [] },
  } as unknown as CatalogPrimaryWorkbenchReadModel;
}

function row(
  editForm: Partial<CatalogPrimaryWorkbenchMergeCandidateReviewRow["editForm"]> = {},
): CatalogPrimaryWorkbenchMergeCandidateReviewRow {
  return {
    candidateId: "cand_1",
    identityLabel: "Charmander / Base Set",
    editForm: {
      state: "available",
      blockers: [],
      baseSnapshotJson: JSON.stringify({
        identityFingerprint: "sha256:cand",
        membership: [{ observationId: "obs_1" }],
      }),
      promotionIntent: "create-catalog-item",
      catalogItemId: null,
      productIds: ["prod_a"],
      editableFacts: [{ key: "name", fieldPath: "catalogItem.name", label: "name", value: "Charmander" }],
      externalCatalogItemReferences: [{ index: 0, label: "tcgplayer:base1-004" }],
      externalProductReferences: [],
      ...editForm,
    },
  } as unknown as CatalogPrimaryWorkbenchMergeCandidateReviewRow;
}

describe("CatalogMergeCandidateEditForm", () => {
  it("renders the typed editor with a base snapshot, field inputs, and promotion intent", () => {
    const { container } = render(<CatalogMergeCandidateEditForm row={row()} readModel={readModel()} />);

    expect(container.querySelector('[data-catalog-merge-candidate-edit-form="true"]')).toBeTruthy();
    expect(container.querySelector('input[name="candidateEditBaseSnapshot"]')).toBeTruthy();
    expect(container.querySelector('input[name="candidateEditFact.name"]')).toBeTruthy();
    expect(container.querySelector('input[name="candidateEditCatalogItemId"]')).toBeTruthy();
    // Editing submits the candidate.edit intent, preserving audit.
    expect(container.querySelector('input[name="_intent"]')).toHaveProperty("value", "candidate.edit");
    // A drop toggle exists for each proposed external reference.
    expect(container.querySelector('input[name="candidateEditDropCatalogRef.0"]')).toBeTruthy();
  });

  it("renders a blocked explanation instead of inputs when editing is unavailable", () => {
    render(
      <CatalogMergeCandidateEditForm
        row={row({ state: "blocked", baseSnapshotJson: null, blockers: ["no-promotion-eligible-observations"] })}
        readModel={readModel()}
      />,
    );

    expect(screen.getByText("Editing unavailable")).toBeTruthy();
  });
});

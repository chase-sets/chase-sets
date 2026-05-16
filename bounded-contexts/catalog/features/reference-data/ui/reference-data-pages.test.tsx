import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReferenceRecordDetailPage } from "./reference-record-detail-page";
import { ReferenceTypeDetailPage } from "./reference-type-detail-page";
import type { ReferenceRecord, ReferenceType } from "./contracts";

const referenceType: ReferenceType = {
  reference_type_id: "rft_set",
  key: "set",
  name_i18n: null,
  name: "Set",
  description_i18n: null,
  description: "Trading card release set",
  attribute_keys: ["card-count", "release-date", "abbreviation", "source-id"],
  status: "active",
  updated_at: "2026-05-16T00:00:00.000Z",
};

const referenceRecord: ReferenceRecord = {
  reference_record_id: "ref_ascended_heroes",
  type_key: "set",
  key: "ascended-heroes",
  name_i18n: null,
  name: "Ascended Heroes",
  description_i18n: null,
  description: "Pokemon set",
  attributes: {
    "card-count": 217,
    "release-date": "2026-01-30",
    abbreviation: "ASC",
    "source-id": "me02.5",
  },
  relationships: [
    {
      relationshipType: "part-of-series",
      referenceId: "ref_mega_evolution",
    },
  ],
  status: "active",
  updated_at: "2026-05-16T00:00:00.000Z",
};

describe("reference data admin pages", () => {
  it("renders reference type attributes", () => {
    const html = renderToString(
      <ReferenceTypeDetailPage id="rft_set" initialData={referenceType} />,
    );

    expect(html).toContain("Set");
    expect(html).toContain("card-count, release-date, abbreviation, source-id");
  });

  it("renders reference record attributes and relationships", () => {
    const html = renderToString(
      <ReferenceRecordDetailPage
        id="ref_ascended_heroes"
        initialData={referenceRecord}
        referenceTypes={[referenceType]}
      />,
    );

    expect(html).toContain("Ascended Heroes");
    expect(html).toContain("card-count: 217");
    expect(html).toContain("release-date: 2026-01-30");
    expect(html).toContain("part-of-series");
    expect(html).toContain("ref_mega_evolution");
  });
});

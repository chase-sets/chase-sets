import { describe, expect, it } from "vitest";
import { labelsToAdd, parseIssueFormLabels, readFormField } from "./issue-form-labels.mjs";

const FILLED = [
  "### Priority",
  "",
  "p1",
  "",
  "### Owning context",
  "",
  "catalog",
  "",
  "### Kind",
  "",
  "tech-debt",
  "",
  "### Context",
  "",
  "Because the projection drifts. See bounded-contexts/catalog/README.md.",
  "",
].join("\n");

describe("issue form labels", () => {
  it("reads a dropdown answer", () => {
    expect(readFormField(FILLED, "Priority")).toBe("p1");
    expect(readFormField(FILLED, "Owning context")).toBe("catalog");
  });

  it("returns null for missing or empty answers", () => {
    expect(readFormField(FILLED, "Nonexistent")).toBeNull();
    expect(readFormField("### Priority\n\n_No response_\n", "Priority")).toBeNull();
    expect(readFormField("### Priority\n\n\n### Kind\n\nproduct\n", "Priority")).toBeNull();
    expect(readFormField(null, "Priority")).toBeNull();
  });

  it("does not bleed the next section into an answer", () => {
    expect(readFormField(FILLED, "Kind")).toBe("tech-debt");
    expect(readFormField(FILLED, "Context")).toContain("projection drifts");
  });

  it("maps answers to the label families", () => {
    expect(parseIssueFormLabels(FILLED)).toEqual(["priority:p1", "area:catalog", "kind:tech-debt"]);
  });

  it("ignores values outside the allowed vocabulary", () => {
    const body = "### Priority\n\np9\n\n### Owning context\n\nnot-a-context\n";
    expect(parseIssueFormLabels(body)).toEqual([]);
  });

  it("is case-insensitive on the answer", () => {
    expect(parseIssueFormLabels("### Priority\n\nP0\n")).toEqual(["priority:p0"]);
  });

  it("skips labels already present", () => {
    expect(labelsToAdd(FILLED, [{ name: "priority:p1" }])).toEqual(["area:catalog", "kind:tech-debt"]);
  });

  it("never overrides a deliberate reclassification within a family", () => {
    // Someone already downgraded this to p2 — the form answer must not undo it.
    expect(labelsToAdd(FILLED, [{ name: "priority:p2" }])).toEqual(["area:catalog", "kind:tech-debt"]);
    expect(labelsToAdd(FILLED, [{ name: "area:discovery" }, { name: "kind:product" }])).toEqual(["priority:p1"]);
  });

  it("adds nothing for a free-form issue with no dropdowns", () => {
    expect(labelsToAdd("Just a plain issue body.", [])).toEqual([]);
  });
});

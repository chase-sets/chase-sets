import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { waitlistAnalyticsEventNames } from "./analytics";

const analyticsDocumentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/landing-page-analytics.md",
);
const analyticsDocument = readFileSync(analyticsDocumentPath, "utf8");
const eventListStart = "Current event names:\n\n";
const eventListEnd = "\n\nEvent details include:";

function parseDocumentedEventNames(markdown: string): string[] {
  const normalizedMarkdown = markdown.replaceAll("\r\n", "\n");
  const startIndex = normalizedMarkdown.indexOf(eventListStart);
  const endIndex = normalizedMarkdown.indexOf(eventListEnd, startIndex + eventListStart.length);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error("Landing analytics document must contain the bounded current-event list");
  }

  return normalizedMarkdown
    .slice(startIndex + eventListStart.length, endIndex)
    .split("\n")
    .map((line) => {
      const match = /^- `([^`]+)`$/.exec(line);
      if (!match) {
        throw new Error(`Invalid current-event list entry: ${line}`);
      }
      return match[1]!;
    });
}

function replaceDocumentedEventNames(markdown: string, eventNames: readonly string[]): string {
  const normalizedMarkdown = markdown.replaceAll("\r\n", "\n");
  const startIndex = normalizedMarkdown.indexOf(eventListStart);
  const endIndex = normalizedMarkdown.indexOf(eventListEnd, startIndex + eventListStart.length);
  const renderedEventNames = eventNames.map((eventName) => `- \`${eventName}\``).join("\n");

  return `${normalizedMarkdown.slice(0, startIndex + eventListStart.length)}${renderedEventNames}${normalizedMarkdown.slice(endIndex)}`;
}

describe("landing page analytics documentation", () => {
  it("lists the exported production event vocabulary in exact order", () => {
    expect(parseDocumentedEventNames(analyticsDocument)).toEqual(waitlistAnalyticsEventNames);
  });

  it.each([
    ["removal", (eventNames: string[]) => eventNames.slice(1)],
    ["extra entry", (eventNames: string[]) => [...eventNames, "synthetic_extra_event"]],
    ["duplicate", (eventNames: string[]) => [eventNames[0]!, ...eventNames]],
    ["reorder", (eventNames: string[]) => [eventNames[1]!, eventNames[0]!, ...eventNames.slice(2)]],
  ])("rejects a documented %s", (_difference, mutate) => {
    const driftedDocument = replaceDocumentedEventNames(
      analyticsDocument,
      mutate(parseDocumentedEventNames(analyticsDocument)),
    );

    expect(parseDocumentedEventNames(driftedDocument)).not.toEqual(waitlistAnalyticsEventNames);
  });
});

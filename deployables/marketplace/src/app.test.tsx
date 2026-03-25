import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./app";

describe("marketplace deployable", () => {
  it("mounts the discovery marketplace shell", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/marketplace/categories")) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }

      return Promise.resolve(new Response(JSON.stringify({ items: [], total: 0, count: 0 }), { status: 200 }));
    }));

    render(<App />);

    expect(await screen.findByText("Marketplace")).toBeTruthy();
  });
});

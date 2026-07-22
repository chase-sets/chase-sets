import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NativeSelect, TextInput } from "../components/forms";

describe("DS control-size contract", () => {
  it("defaults TextInput to today's md classes when controlSize is omitted", () => {
    render(<TextInput label="Email" />);
    const input = screen.getByLabelText("Email");

    expect(input.className).toContain("min-h-[var(--control-md-height)]");
    expect(input.className).toContain("px-[var(--control-md-px)]");
    expect(input.className).toContain("py-[var(--control-md-py)]");
    expect(input.className).toContain("text-sm");
    expect(input.className).not.toContain("text-base");
  });

  it("applies the lg classes, including the text-base 16px contract, when controlSize is lg", () => {
    render(<TextInput label="Email" controlSize="lg" />);
    const input = screen.getByLabelText("Email");

    expect(input.className).toContain("min-h-[var(--control-lg-height)]");
    expect(input.className).toContain("px-[var(--control-lg-px)]");
    expect(input.className).toContain("py-[var(--control-lg-py)]");
    expect(input.className).toContain("text-base");
    expect(input.className).not.toContain("text-sm");
  });

  it("defaults NativeSelect to today's md classes when controlSize is omitted", () => {
    render(<NativeSelect label="Role" items={[{ value: "buy", label: "Buy" }]} />);
    const select = screen.getByLabelText("Role");

    expect(select.className).toContain("min-h-[var(--control-md-height)]");
    expect(select.className).toContain("text-sm");
    expect(select.className).not.toContain("text-base");
  });

  it("applies the lg classes, including the text-base 16px contract, to NativeSelect when controlSize is lg", () => {
    render(<NativeSelect label="Role" items={[{ value: "buy", label: "Buy" }]} controlSize="lg" />);
    const select = screen.getByLabelText("Role");

    expect(select.className).toContain("min-h-[var(--control-lg-height)]");
    expect(select.className).toContain("text-base");
    expect(select.className).not.toContain("text-sm");
  });
});

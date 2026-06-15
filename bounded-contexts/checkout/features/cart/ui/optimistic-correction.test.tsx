// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOptimisticCorrection, type OptimisticCorrectionSubmit } from "./optimistic-correction";

function Harness({
  sourceValue,
  submitting,
  rejected = false,
  submit,
}: {
  sourceValue: number;
  submitting: boolean;
  rejected?: boolean;
  submit: OptimisticCorrectionSubmit<number>;
}) {
  const correction = useOptimisticCorrection({
    resourceKey: "cart-line-1",
    sourceValue,
    correctionSource: "loader-revalidation",
    submitting,
    rejected,
    submit,
  });

  return (
    <>
      <output aria-label="quantity">{correction.value}</output>
      <output aria-label="status">{correction.status}</output>
      <button type="button" onClick={() => correction.setOptimisticValue(correction.value + 1)}>
        Increase
      </button>
    </>
  );
}

describe("optimistic correction primitive", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the optimistic value immediately and submits correction metadata", () => {
    const submit = vi.fn();

    render(<Harness sourceValue={2} submitting={false} submit={submit} />);

    act(() => screen.getByText("Increase").click());

    expect(screen.getByLabelText("quantity").textContent).toBe("3");
    expect(screen.getByLabelText("status").textContent).toBe("pending");
    expect(submit).toHaveBeenCalledWith({
      value: 3,
      sequence: 1,
      correctionSource: "loader-revalidation",
    });
  });

  it("coalesces rapid repeated edits while one write is in flight", () => {
    const submit = vi.fn();
    const { rerender } = render(<Harness sourceValue={2} submitting={false} submit={submit} />);

    act(() => screen.getByText("Increase").click());
    rerender(<Harness sourceValue={2} submitting submit={submit} />);
    act(() => screen.getByText("Increase").click());
    act(() => screen.getByText("Increase").click());

    expect(screen.getByLabelText("quantity").textContent).toBe("5");
    expect(submit).toHaveBeenCalledTimes(1);

    rerender(<Harness sourceValue={3} submitting={false} submit={submit} />);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({ value: 5, sequence: 3 });
  });

  it("does not let stale loader truth overwrite the latest queued optimistic value", () => {
    const submit = vi.fn();
    const { rerender } = render(<Harness sourceValue={2} submitting={false} submit={submit} />);

    act(() => screen.getByText("Increase").click());
    rerender(<Harness sourceValue={2} submitting submit={submit} />);
    act(() => screen.getByText("Increase").click());
    act(() => screen.getByText("Increase").click());

    rerender(<Harness sourceValue={3} submitting submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("5");
    expect(screen.getByLabelText("status").textContent).toBe("pending");
    expect(submit).toHaveBeenCalledTimes(1);

    rerender(<Harness sourceValue={3} submitting={false} submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("5");
    expect(screen.getByLabelText("status").textContent).toBe("pending");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({ value: 5, sequence: 3 });
  });

  it("discards stale loader responses until the source catches up to the optimistic value", () => {
    const submit = vi.fn();
    const { rerender } = render(<Harness sourceValue={2} submitting={false} submit={submit} />);

    act(() => screen.getByText("Increase").click());
    rerender(<Harness sourceValue={1} submitting submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("3");
    expect(screen.getByLabelText("status").textContent).toBe("pending");

    rerender(<Harness sourceValue={1} submitting={false} submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("3");
    expect(screen.getByLabelText("status").textContent).toBe("pending");

    rerender(<Harness sourceValue={3} submitting={false} submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("3");
    expect(screen.getByLabelText("status").textContent).toBe("idle");
  });

  it("rolls back to loader truth on rejection", () => {
    const submit = vi.fn();
    const { rerender } = render(<Harness sourceValue={2} submitting={false} submit={submit} />);

    act(() => screen.getByText("Increase").click());
    rerender(<Harness sourceValue={2} submitting rejected submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("2");
    expect(screen.getByLabelText("status").textContent).toBe("rejected");
  });

  it("reconciles to fresh loader truth after pending work settles", () => {
    const submit = vi.fn();
    const { rerender } = render(<Harness sourceValue={2} submitting={false} submit={submit} />);

    act(() => screen.getByText("Increase").click());
    rerender(<Harness sourceValue={2} submitting submit={submit} />);
    rerender(<Harness sourceValue={3} submitting={false} submit={submit} />);

    expect(screen.getByLabelText("quantity").textContent).toBe("3");
    expect(screen.getByLabelText("status").textContent).toBe("idle");
  });
});

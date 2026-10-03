import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDelayedFlag } from "@/components/useDelayedFlag";

/**
 * Pins the delayed-skeleton fix: useDelayedFlag must stay FALSE until `active`
 * has been true for the full delay (so fast loads never flash the skeleton),
 * flip TRUE once the delay elapses, and reset to FALSE immediately when the
 * load finishes. If the timer is dropped, test (a) fails; if the immediate
 * reset is dropped, test (c) fails.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("stays false before the delay elapses, flips true after", () => {
  const { result } = renderHook(() => useDelayedFlag(true, 250));

  // Immediately active → still false.
  expect(result.current).toBe(false);

  act(() => {
    vi.advanceTimersByTime(249);
  });
  expect(result.current).toBe(false);

  act(() => {
    vi.advanceTimersByTime(1); // cross 250ms
  });
  expect(result.current).toBe(true);
});

it("resets to false immediately when active goes false", () => {
  const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 250), {
    initialProps: { active: true },
  });

  act(() => {
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(true);

  // Load finished — flag clears without advancing any timer.
  rerender({ active: false });
  expect(result.current).toBe(false);
});

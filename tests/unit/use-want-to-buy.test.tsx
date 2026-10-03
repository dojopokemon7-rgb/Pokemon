import { it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import { useWantToBuy } from "@/lib/hooks/useWantToBuy";

/**
 * Pins the perf-optimize "Want to Buy" fix: the star must flip OPTIMISTICALLY
 * — the moment of the tap, while the POST is still in flight — and REVERT if
 * the request fails. This is the single runnable check for the optimistic
 * cache logic in useWantToBuy. If the mutations regress to a plain
 * `onSettled: invalidate` with no `onMutate`, `isWanted` would NOT be true
 * while the POST is pending (the exact lag the user reported) and the first
 * test fails; drop `onError` and the revert test fails.
 */

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** A promise we resolve/reject by hand, to hold the POST "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CARD = { externalId: "base1-4", name: "Charizard" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("flips isWanted true while the add POST is still in flight (optimistic)", async () => {
  const gate = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      // Hold the POST open so the ONLY way isWanted can be true here is the
      // optimistic onMutate cache write — not a post-response refetch.
      return gate.promise;
    })
  );

  const client = makeClient();
  const { result } = renderHook(() => useWantToBuy(), { wrapper: wrapper(client) });

  expect(result.current.isWanted(CARD.externalId)).toBe(false);

  await act(async () => {
    result.current.toggle(CARD);
  });

  // POST still pending — optimistic update already shows the star as wanted.
  await waitFor(() => expect(result.current.isWanted(CARD.externalId)).toBe(true));

  // Let the POST complete so the hook settles cleanly.
  await act(async () => {
    gate.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
});

it("reverts the optimistic add when the POST fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response("boom", { status: 500 });
    })
  );

  const client = makeClient();
  const { result } = renderHook(() => useWantToBuy(), { wrapper: wrapper(client) });

  await act(async () => {
    result.current.toggle(CARD);
  });

  // onError restores the pre-tap snapshot after the failed POST settles.
  await waitFor(() => expect(result.current.isWanted(CARD.externalId)).toBe(false));
});

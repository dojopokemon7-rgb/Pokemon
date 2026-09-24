/**
 * React Query Provider + global client-side providers.
 * Wrap the app root with QueryClientProvider so any client
 * component can use useQuery / useMutation hooks.
 */
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per browser session, created lazily to avoid sharing
  // state between server renders.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data stays fresh for 5 minutes before a background refetch —
            // switching between the bottom-nav tabs (dashboard / portfolio /
            // search / want-list) reads straight from cache instead of
            // refetching, so a tab switch is instant. Explicit
            // invalidateQueries on mutations still updates immediately.
            staleTime: 5 * 60 * 1000,
            // Keep cached data for 10 minutes after the last observer
            // unmounts, so tabbing away and back within that window is a
            // cache hit (no loading spinner, no network round-trip).
            gcTime: 10 * 60 * 1000,
            // Retry once on failure (external APIs can be flaky)
            retry: 1,
            // Don't refetch every time the user tabs back — for a mobile
            // PWA that fires on every phone unlock. Cache stays fresh via
            // `staleTime`; explicit invalidations still work.
            refetchOnWindowFocus: false,
            // Skip the reconnect refetch storm too — same reasoning.
            refetchOnReconnect: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

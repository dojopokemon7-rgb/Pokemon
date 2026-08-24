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
            // Data stays fresh for 60 seconds before a background refetch
            staleTime: 60 * 1000,
            // Keep cached data for 5 minutes after the component unmounts
            gcTime: 5 * 60 * 1000,
            // Retry once on failure (external APIs can be flaky)
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

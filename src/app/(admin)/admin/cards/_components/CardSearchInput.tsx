"use client";

/**
 * Card search input for the admin cards page.
 *
 * Debounced client-side navigation instead of a submit button — keeps
 * the URL as the single source of truth (server component reads `?q=`)
 * so results still work with browser back/forward and page refreshes.
 */

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const DEBOUNCE_MS = 250;

export function CardSearchInput({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const next = value.trim();
      if (next) params.set("q", next);
      else params.delete("q");
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // Deliberately depending on `value` only — pathname/searchParams
    // change churn from routing itself would loop otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="search"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search by card name or set…"
      className="dojo-input"
      aria-label="Search cards"
    />
  );
}

"use client";

/**
 * Want List (F-07) — /wantlist
 *
 * Thin route wrapper around the shared <WantList> body (also rendered inside
 * the Portfolio "Want List" group). All the fetch/move/remove logic lives in
 * src/components/WantList.tsx so there's a single source of truth.
 */

import { WantList } from "@/components/WantList";

export default function WantListPage() {
  return (
    <div style={{ padding: "18px 22px 24px" }}>
      <WantList />
    </div>
  );
}

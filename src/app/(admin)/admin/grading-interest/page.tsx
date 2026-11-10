/**
 * Admin — Grading Interest
 *
 * CGC "notify me" submissions from the landing's /grading-services form
 * (table grading_interest). Totals, breakdowns, newest-first table with offset
 * pagination, and a CSV (Excel) export. Honest empty + missing-table states.
 */
import Link from "next/link";
import {
  GRADING_PAGE_SIZE,
  getGradingInterestOverview,
  isMissingTable,
} from "@/lib/services/grading-interest.service";
import { formatDateTime } from "@/lib/utils/format";
import { requireAdminPage } from "@/lib/utils/require-admin-page";

export const dynamic = "force-dynamic";

export default async function AdminGradingInterestPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  await requireAdminPage();
  const { offset: rawOffset } = await searchParams;
  const offset = Math.max(0, Math.floor(Number(rawOffset)) || 0);

  let data: Awaited<ReturnType<typeof getGradingInterestOverview>> | null = null;
  let error: string | null = null;
  try {
    data = await getGradingInterestOverview(offset);
  } catch (err) {
    error = isMissingTable(err)
      ? "Table not created — run the grading_interest migration."
      : "Could not load submissions.";
    console.error(`[admin/grading-interest] load failed (missing=${isMissingTable(err)})`);
  }

  return (
    <div className="px-10 py-10">
      <header className="mb-6" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="dojo-step-label" style={{ fontSize: "10px", marginBottom: "8px" }}>
            Admin
          </div>
          <h1 className="dojo-heading" style={{ fontSize: "32px" }}>
            Grading Interest
          </h1>
          <p className="dojo-body" style={{ marginTop: "6px" }}>
            {data ? `${data.total.toLocaleString()} total` : "—"}
          </p>
        </div>
        {data && data.total > 0 && (
          <a
            href="/api/admin/grading-interest/export"
            download
            className="dojo-tag acc"
            style={{ fontSize: "10px", padding: "10px 16px", textDecoration: "none" }}
          >
            Export to Excel (CSV)
          </a>
        )}
      </header>

      {error && (
        <div role="alert" className="dojo-body" style={{ padding: "20px", border: "1px solid var(--color-dojo-stroke)" }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "20px" }}>
            <Breakdown title="By category" counts={data.byCategory} />
            <Breakdown title="By volume" counts={data.byVolume} />
          </div>
          <div style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <Th>Email</Th>
                  <Th>Category</Th>
                  <Th>Volume</Th>
                  <Th>Joined</Th>
                  <Th>Updated</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="dojo-faint" style={{ padding: "40px 20px", textAlign: "center" }}>
                      No submissions yet.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--color-dojo-divider)" }}>
                      <Td>{r.email}</Td>
                      <Td>{r.category}</Td>
                      <Td>{r.volume}</Td>
                      <Td>{formatDateTime(r.joinedAt)}</Td>
                      <Td>{r.updatedAt ? formatDateTime(r.updatedAt) : "—"}</Td>
                      <Td>{r.source ?? "—"}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pagination" style={{ display: "flex", gap: "16px", marginTop: "16px" }} className="dojo-body">
            {offset > 0 && (
              <Link href={`/admin/grading-interest?offset=${Math.max(0, offset - GRADING_PAGE_SIZE)}`}>← Newer</Link>
            )}
            {offset + GRADING_PAGE_SIZE < data.total && (
              <Link href={`/admin/grading-interest?offset=${offset + GRADING_PAGE_SIZE}`}>Older →</Link>
            )}
          </nav>
        </>
      )}
    </div>
  );
}

function Breakdown({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <div style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "14px 20px", minWidth: "220px" }}>
      <div className="dojo-step-label" style={{ fontSize: "10px", marginBottom: "8px" }}>{title}</div>
      {entries.length === 0 ? (
        <div className="dojo-faint">—</div>
      ) : (
        entries.map(([k, n]) => (
          <div key={k} className="dojo-body" style={{ display: "flex", justifyContent: "space-between", gap: "24px" }}>
            <span>{k}</span>
            <span>{n.toLocaleString()}</span>
          </div>
        ))
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "14px 20px",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "9.5px",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--color-dojo-body)",
        borderBottom: "1px solid var(--color-dojo-stroke)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "14px 20px", fontSize: "12.5px", color: "var(--color-dojo-ink)" }}>{children}</td>;
}

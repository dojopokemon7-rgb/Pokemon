/**
 * Shared display formatters for the admin panel.
 * Kept in one place so currency/date output stays consistent across pages.
 */

const CURRENCY_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatCurrency(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return CURRENCY_FMT.format(value);
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return DATE_FMT.format(d);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return DATE_TIME_FMT.format(d);
}

/** e.g. "2 days ago", "5 minutes ago", "just now". */
export function formatRelative(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const diffMs = Date.now() - d.getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

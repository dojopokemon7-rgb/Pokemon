"use client";

import { useState } from "react";

// Custom listbox (no native <select>) — dark box + chevron trigger that
// opens a dark panel of full-name rows with thin dividers. Reuses the
// .dojo-select-trigger/.dojo-menu styling already in globals.css; rows use
// a dark-gray hover/selected highlight (no browser blue). Closes on outside
// click or Escape.
export function DojoSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  testId,
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
        className={`dojo-select-trigger${open ? " open" : ""}`}
        style={{ width: "100%" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`val${selected ? "" : " ph"}`}>{selected?.label ?? placeholder ?? "Select"}</span>
        <span className="chev" aria-hidden="true">
          <svg width="12" height="7" viewBox="0 0 12 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
            <path d="M1 1l5 5 5-5" />
          </svg>
        </span>
      </button>
      {open && (
        <>
          {/* Outside-click scrim closes the panel. */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
          <div role="listbox" aria-label={ariaLabel} className="dojo-menu" style={{ top: "100%", marginTop: "4px", zIndex: 60 }}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  className="row"
                  // Dark-gray highlight for selected/hover (no gold tint, no
                  // browser blue). Hover handled via inline pointer events so
                  // we don't need a new CSS class.
                  style={{ background: on ? "var(--color-dojo-raised-2, #2a2a2a)" : "transparent" }}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--color-dojo-raised-2, #2a2a2a)"; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  <span style={{ flex: 1 }}>{o.label}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

"use client";

/**
 * Contact Support (F-21) — expandable form on the /you settings page.
 *
 * Replaces the old dead "CONTACT SUPPORT" button. Clicking it expands a
 * form (Name, Email, Subject, Message) pre-filled from the session, POSTs
 * to /api/support, and shows a success/error toast based on the response.
 */

import { useState } from "react";
import { Toast } from "@/components/Toast";

interface Props {
  defaultName?: string;
  defaultEmail?: string;
}

export function ContactSupport({ defaultName = "", defaultEmail = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: "neutral" | "error" } | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, email, subject, message }),
      });
      if (res.ok) {
        setToast({ msg: "Support ticket submitted!", tone: "neutral" });
        setSubject("");
        setMessage("");
        setOpen(false);
      } else {
        setToast({ msg: "Failed to send, please try again", tone: "error" });
      }
    } catch {
      setToast({ msg: "Failed to send, please try again", tone: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const label: React.CSSProperties = { marginTop: "6px" };
  const canSubmit = name.trim() && email.trim() && subject.trim() && message.trim() && !submitting;

  return (
    <>
      {!open ? (
        <button
          type="button"
          className="dojo-btn dojo-btn-outline"
          style={{ height: "44px" }}
          onClick={() => setOpen(true)}
        >
          CONTACT SUPPORT
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "12px", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)" }}>
          <div className="dojo-label" style={label}>Name</div>
          <input className="dojo-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Name" />

          <div className="dojo-label" style={label}>Email</div>
          <input className="dojo-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@domain.com" aria-label="Email" />

          <div className="dojo-label" style={label}>Subject</div>
          <input className="dojo-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="How can we help?" aria-label="Subject" />

          <div className="dojo-label" style={label}>Message</div>
          <textarea className="dojo-input" value={message} onChange={(e) => setMessage(e.target.value)} rows={4} placeholder="Describe your issue…" aria-label="Message" />

          {/* Both .dojo-btn variants default to width:100% and different
              heights (primary 52px / outline 43px), which made them overlap
              in a flex row. Pin each to flex:1 + a shared height and override
              the 100% width so they sit side-by-side, equal-sized. */}
          <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
            <button
              type="button"
              className="dojo-btn dojo-btn-primary"
              disabled={!canSubmit}
              onClick={handleSubmit}
              style={{ flex: 1, width: "auto", height: "44px" }}
            >
              {submitting ? "Sending…" : "Send message"}
            </button>
            <button
              type="button"
              className="dojo-btn dojo-btn-outline"
              onClick={() => setOpen(false)}
              style={{ flex: 1, width: "auto", height: "44px" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {toast && (
        <Toast message={toast.msg} tone={toast.tone} onDismiss={() => setToast(null)} />
      )}
    </>
  );
}

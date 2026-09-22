import { describe, it, expect, vi } from "vitest";

/**
 * F-21 — Contact Support. RED phase.
 *
 * Supabase/Prisma app (no Firebase). No SMTP / external ticket service is
 * wired up, so the service takes an injectable `deliver` function (the
 * "external ticket service") that the tests mock for success / failure —
 * deterministic, no real provider, no schema change needed to go red.
 *
 * EXPECTED TO FAIL today: neither the `submitSupportTicket` service nor the
 * `ContactSupportSchema` validator exists, and there's no API route (the
 * /you "CONTACT SUPPORT" button is a dead stub).
 */

import {
  submitSupportTicket,
  type ContactSupportInput,
} from "@/lib/services/support.service";
import { ContactSupportSchema } from "@/lib/validators/support.validator";

const VALID: ContactSupportInput = {
  name: "Ash Ketchum",
  email: "ash@example.com",
  subject: "Missing card",
  message: "A card I added isn't showing in my collection.",
};

describe("submitSupportTicket — happy path", () => {
  it("delivers a valid ticket and returns success", async () => {
    const deliver = vi.fn().mockResolvedValue({ id: "ticket_1" });

    const result = await submitSupportTicket(VALID, { deliver });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ash@example.com", subject: "Missing card" })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ticketId).toBe("ticket_1");
  });
});

describe("submitSupportTicket — validation errors", () => {
  it("rejects an empty message and never calls deliver", async () => {
    const deliver = vi.fn();
    const result = await submitSupportTicket({ ...VALID, message: "" }, { deliver });

    expect(result.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects an invalid email and never calls deliver", async () => {
    const deliver = vi.fn();
    const result = await submitSupportTicket({ ...VALID, email: "not-an-email" }, { deliver });

    expect(result.ok).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("ContactSupportSchema flags each required field", () => {
    expect(ContactSupportSchema.safeParse(VALID).success).toBe(true);
    expect(ContactSupportSchema.safeParse({ ...VALID, name: "" }).success).toBe(false);
    expect(ContactSupportSchema.safeParse({ ...VALID, subject: "" }).success).toBe(false);
    expect(ContactSupportSchema.safeParse({ ...VALID, email: "nope" }).success).toBe(false);
  });
});

describe("submitSupportTicket — failure state", () => {
  it("returns a graceful error (does not throw) when delivery fails", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("ticket service 500"));

    const result = await submitSupportTicket(VALID, { deliver });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("try again");
    }
  });
});

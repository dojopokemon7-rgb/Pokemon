/**
 * Support Service (F-21 Contact Support).
 *
 * Validates a contact-support submission and hands it to a `deliver`
 * function. Delivery is injectable so tests can mock success/failure; the
 * default persists a SupportTicket row in Postgres via Prisma (Option A —
 * gives us an admin queue to build on later).
 *
 * Always returns a result object, never throws — the API route maps it to
 * an HTTP status, and a delivery failure surfaces as a graceful message
 * rather than a crash.
 */

import { prisma } from "@/lib/db";
import { ContactSupportSchema } from "@/lib/validators/support.validator";

export type { ContactSupportInput } from "@/lib/validators/support.validator";
import type { ContactSupportInput } from "@/lib/validators/support.validator";

/** A validated ticket handed to `deliver`, plus the optional submitter id. */
export interface TicketToDeliver extends ContactSupportInput {
  userId?: string | null;
}

/** Delivery result — an id the caller can echo back to the user. */
export interface DeliveredTicket {
  id: string;
}

export type SubmitResult =
  | { ok: true; ticketId: string }
  | { ok: false; error: string };

export interface SubmitOptions {
  /** How the ticket is delivered. Defaults to persisting via Prisma. */
  deliver?: (ticket: TicketToDeliver) => Promise<DeliveredTicket>;
  /** Submitter's user id when logged in (stamped onto the row). */
  userId?: string | null;
}

/** Default delivery: persist the ticket as a SupportTicket row. */
async function persistTicket(ticket: TicketToDeliver): Promise<DeliveredTicket> {
  const row = await prisma.supportTicket.create({
    data: {
      userId: ticket.userId ?? null,
      name: ticket.name,
      email: ticket.email,
      subject: ticket.subject,
      message: ticket.message,
    },
    select: { id: true },
  });
  return { id: row.id };
}

/**
 * Validates and delivers a support ticket.
 *
 * - Invalid input → `{ ok: false }` and `deliver` is never called.
 * - Delivery throws → `{ ok: false, error: "...try again later" }`.
 * - Success → `{ ok: true, ticketId }`.
 */
export async function submitSupportTicket(
  input: ContactSupportInput,
  options: SubmitOptions = {}
): Promise<SubmitResult> {
  const parsed = ContactSupportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const deliver = options.deliver ?? persistTicket;

  try {
    const delivered = await deliver({ ...parsed.data, userId: options.userId ?? null });
    return { ok: true, ticketId: delivered.id };
  } catch {
    return { ok: false, error: "Failed to send message, please try again later." };
  }
}

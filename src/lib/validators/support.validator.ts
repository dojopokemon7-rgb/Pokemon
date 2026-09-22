/**
 * Contact Support validation (F-21).
 *
 * Guards the contact form fields before a ticket is created. Shared by the
 * support service and the /api/support route.
 */

import { z } from "zod";

export const ContactSupportSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().email("A valid email is required."),
  subject: z.string().trim().min(1, "Subject is required.").max(160),
  message: z.string().trim().min(1, "Message is required.").max(5000),
});

export type ContactSupportInput = z.infer<typeof ContactSupportSchema>;

/*
 * Contact form client. POSTs to the Next app's /api/contact, which emails the
 * Dojo team. The limits mirror the server's Zod schema
 * (src/lib/validators/contact.validator.ts); the server stays the authority.
 */
export const LIMITS = { name: 100, email: 254, subject: 150, messageMin: 10, messageMax: 5000 }
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
}
/** Returns { field: message } for every invalid field; {} when the form is good. */
export function validate({ name, email, subject, message }) {
  const e = {}
  if (!name.trim()) e.name = 'Tell us your name.'
  else if (name.trim().length > LIMITS.name) e.name = `Keep your name under ${LIMITS.name} characters.`
  if (!isValidEmail(email) || email.trim().length > LIMITS.email) e.email = 'That email doesn’t look right. Check it and try again.'
  if (subject.trim().length > LIMITS.subject) e.subject = `Keep the subject under ${LIMITS.subject} characters.`
  const m = message.trim().length
  if (m < LIMITS.messageMin) e.message = `Write at least ${LIMITS.messageMin} characters so we can help.`
  else if (m > LIMITS.messageMax) e.message = `Keep the message under ${LIMITS.messageMax} characters.`
  return e
}
/** Resolves on success; throws an Error whose message is safe to show. Server field errors ride on err.fields. */
export async function sendContact(values) {
  let res
  try {
    res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: values.name.trim(),
        email: values.email.trim(),
        subject: values.subject.trim(),
        message: values.message.trim(),
        website: values.website,
        page: '/contact',
      }),
    })
  } catch {
    throw new Error('Couldn’t reach the server. Check your connection, or email dojo.collect@nodwin.com.')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) {
    const err = new Error(body.error || 'Could not send your message right now. Please email dojo.collect@nodwin.com.')
    err.fields = body.fields
    throw err
  }
}
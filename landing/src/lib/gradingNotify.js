/*
 * Grading notify-me client. POSTs to the Worker, which keeps one row per
 * address in D1 — a repeat signup just updates what they said they'd send.
 */

export const CATEGORIES = [
  { value: 'cards', label: 'Cards' },
  { value: 'comics', label: 'Comics' },
  { value: 'both', label: 'Both' },
]

export const VOLUMES = [
  { value: '1-10', label: '1–10' },
  { value: '11-50', label: '11–50' },
  { value: '51-200', label: '51–200' },
  { value: '200+', label: '200+' },
]

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
}

export async function notifyMe({ email, category, volume }) {
  let res
  try {
    res = await fetch('/api/grading/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        category,
        volume,
        source: 'grading-page',
      }),
    })
  } catch {
    throw new Error('Couldn’t reach the server. Check your connection and try again.')
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) {
    throw new Error(body.error || 'Couldn’t save that just now. Try again.')
  }

  // `returning` means the address was already on the list
  return { returning: !!body.returning }
}

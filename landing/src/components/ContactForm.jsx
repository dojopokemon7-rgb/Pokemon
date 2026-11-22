import { useState } from 'react'
import { Button } from './ui.jsx'
import { LIMITS, sendContact, validate } from '../lib/contact.js'
const EMPTY = { name: '', email: '', subject: '', message: '', website: '' }
/* One labelled field. Errors are tied to the control with aria-describedby and
   announced with role="alert"; the control itself carries aria-invalid. */
function Field({ id, label, optional, error, children }) {
  return (
    <div className={`dojo-field ${error ? 'dojo-field--error' : ''}`}>
      <label htmlFor={id} className={`dojo-field__label ${error ? 'dojo-field__label--error' : ''}`}>
        {label}
        {optional && <span className="cform__optional"> (optional)</span>}
      </label>
      {children}
      {error && (
        <span id={`${id}-error`} className="t-small gform__error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
export default function ContactForm() {
  const [values, setValues] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const set = (key) => (e) => {
    setValues((v) => ({ ...v, [key]: e.target.value }))
    // fixing a field clears its message straight away, not on the next submit
    setErrors(({ [key]: _, form, ...rest }) => rest)
  }
  const bind = (key, error) => ({
    id: `contact-${key}`,
    value: values[key],
    onChange: set(key),
    'aria-invalid': !!error,
    'aria-describedby': error ? `contact-${key}-error` : undefined,
  })
  if (sent) {
    return (
      <div className="gform__done" role="status">
        <p className="gform__done-title">
          <span className="glyph-gold" aria-hidden="true">◆</span>
          Thanks — we'll get back to you.
        </p>
        <p className="gform__done-body">
          Your message is with the Dojo team. We reply to the email address you gave us.
        </p>
      </div>
    )
  }
  const submit = async (e) => {
    e.preventDefault()
    const next = validate(values)
    setErrors(next)
    if (Object.keys(next).length) return
    setSending(true)
    try {
      await sendContact(values)
      setSent(true)
    } catch (err) {
      setErrors({ ...(err.fields || {}), form: err?.message || 'Something went wrong. Try again.' })
    } finally {
      setSending(false)
    }
  }
  return (
    <form className="gform" onSubmit={submit} noValidate>
      <Field id="contact-name" label="Name" error={errors.name}>
        <input type="text" autoComplete="name" maxLength={LIMITS.name} {...bind('name', errors.name)} />
      </Field>
      <Field id="contact-email" label="Email" error={errors.email}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          maxLength={LIMITS.email}
          {...bind('email', errors.email)}
        />
      </Field>
      <Field id="contact-subject" label="Subject" optional error={errors.subject}>
        <input type="text" maxLength={LIMITS.subject} {...bind('subject', errors.subject)} />
      </Field>
      <Field id="contact-message" label="Message" error={errors.message}>
        <textarea rows={7} maxLength={LIMITS.messageMax} {...bind('message', errors.message)} />
      </Field>
      {/* honeypot: people never see or reach it; bots that fill every field give themselves away */}
      <div className="cform__hp" aria-hidden="true">
        <label htmlFor="contact-website">Leave this field empty</label>
        <input
          id="contact-website"
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={set('website')}
        />
      </div>
      {errors.form && (
        <p className="t-small gform__error" role="alert">
          {errors.form}
        </p>
      )}
      <Button variant="primary" size="big" type="submit" fullWidth showArrow disabled={sending}>
        {sending ? 'Sending…' : 'Send message'}
      </Button>
      <p className="t-small gform__fine">
        Prefer email? Write to <a href="mailto:dojo.collect@nodwin.com">dojo.collect@nodwin.com</a>. See our{' '}
        <a href="/privacy">privacy policy</a>.
      </p>
    </form>
  )
}
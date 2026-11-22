import { useState } from 'react'
import { Button } from './ui.jsx'
import { CATEGORIES, VOLUMES, isValidEmail, notifyMe } from '../lib/gradingNotify.js'
import { SIGN_IN_URL, SIGN_UP_URL } from '../lib/product.js'

/* A row of radio inputs worn as square chips. The input stays in the DOM, so
   arrow keys, form semantics and screen readers all behave like a radio group. */
function Chips({ name, legend, options, value, onChange, error }) {
  const errorId = `${name}-error`
  return (
    <fieldset className="gform__group" aria-describedby={error ? errorId : undefined}>
      <legend className={`dojo-field__label ${error ? 'dojo-field__label--error' : ''}`}>{legend}</legend>
      <div className="gchips">
        {options.map((o) => (
          <label key={o.value} className="gchip">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="gchip__face num">{o.label}</span>
          </label>
        ))}
      </div>
      {error && (
        <span id={errorId} className="t-small gform__error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  )
}

export default function NotifyForm() {
  const [email, setEmail] = useState('')
  const [category, setCategory] = useState('')
  const [volume, setVolume] = useState('')
  const [errors, setErrors] = useState({})
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(null)

  // fixing a field clears its message straight away, not on the next submit
  const clear = (key) => setErrors(({ [key]: _, form, ...rest }) => rest)

  /* Two steps: the email is saved, then the Dojo sign-up. We can't tell from
     here whether someone already has a Dojo account, so the sign-up is offered
     to everyone and the fine print lets existing members off the hook. */
  if (done) {
    return (
      <div className="gform__steps">
        <div className="gform__done" role="status">
          <p className="gform__done-title">
            <span className="glyph-gold" aria-hidden="true">◆</span>
            {done.returning ? 'You’re already on the list.' : 'You’re on the list.'}
          </p>
          <p className="gform__done-body">
            {done.returning
              ? 'We’ve updated what you told us you’d send. We’ll email you the day mail-in submissions open.'
              : `We’ll email ${done.email} the day mail-in submissions open.`}
          </p>
        </div>

        <div className="gform__next">
          <p className="t-caps gsec__label">
            <span className="glyph-gold" aria-hidden="true">◆</span> Next step
          </p>
          <p className="gform__next-title">Sign up to Dojo</p>
          <p className="gform__done-body">
            Your Dojo account is where you’ll track your submission, from the day it reaches us to
            the day your grades are in.
          </p>
          <Button variant="primary" size="big" href={SIGN_UP_URL} fullWidth showArrow>
            Sign up to Dojo
          </Button>
          <p className="t-small gform__fine">
            Already on Dojo? <a href={SIGN_IN_URL}>Sign in</a>.
          </p>
        </div>
      </div>
    )
  }

  const submit = async (e) => {
    e.preventDefault()
    const next = {}
    if (!isValidEmail(email)) next.email = 'That email doesn’t look right. Check it and try again.'
    if (!category) next.category = 'Pick what you’d send.'
    if (!volume) next.volume = 'Pick roughly how many.'
    setErrors(next)
    if (Object.keys(next).length) return

    setSending(true)
    try {
      const res = await notifyMe({ email, category, volume })
      setDone({ ...res, email: email.trim().toLowerCase() })
    } catch (err) {
      setErrors({ form: err?.message || 'Something went wrong. Try again.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <form className="gform" onSubmit={submit} noValidate>
      <div className={`dojo-field ${errors.email ? 'dojo-field--error' : ''}`}>
        <label htmlFor="notify-email" className={`dojo-field__label ${errors.email ? 'dojo-field__label--error' : ''}`}>
          Email
        </label>
        <input
          id="notify-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            clear('email')
          }}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? 'notify-email-error' : undefined}
        />
        {errors.email && (
          <span id="notify-email-error" className="t-small gform__error" role="alert">
            {errors.email}
          </span>
        )}
      </div>

      <Chips
        name="category"
        legend="What would you send?"
        options={CATEGORIES}
        value={category}
        onChange={(v) => {
          setCategory(v)
          clear('category')
        }}
        error={errors.category}
      />

      <Chips
        name="volume"
        legend="Roughly how many?"
        options={VOLUMES}
        value={volume}
        onChange={(v) => {
          setVolume(v)
          clear('volume')
        }}
        error={errors.volume}
      />

      {errors.form && (
        <p className="t-small gform__error" role="alert">
          {errors.form}
        </p>
      )}

      <Button variant="primary" size="big" type="submit" fullWidth showArrow disabled={sending}>
        {sending ? 'Saving…' : 'Notify me'}
      </Button>

      <p className="t-small gform__fine">
        We’ll only email you about CGC submissions. See our{' '}
        <a href="/privacy">privacy policy</a>.
      </p>
    </form>
  )
}

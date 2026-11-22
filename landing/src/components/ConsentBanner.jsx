import { useEffect, useState } from 'react'
import { Button } from './ui.jsx'
/*
 * Analytics consent. Same localStorage key as the Dojo app, so a choice made on
 * the app carries over to these pages. The gtag default (all denied) is set in
 * each page's <head>; only analytics_storage is ever granted here, never ad_*.
 */
const KEY = 'dojo-analytics-consent'
const EVENT = 'dojo-consent-changed'
function read() {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'granted' || v === 'denied' ? v : null
  } catch {
    return null
  }
}
function choose(value) {
  try {
    window.localStorage.setItem(KEY, value)
  } catch {}
  if (value === 'granted' && typeof window.gtag === 'function') {
    window.gtag('consent', 'update', { analytics_storage: 'granted' })
  }
  window.dispatchEvent(new Event(EVENT))
}
export default function ConsentBanner() {
  const [choice, setChoice] = useState('pending')
  useEffect(() => {
    const v = read()
    if (v === 'granted' && typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: 'granted' })
    }
    setChoice(v)
    const sync = () => setChoice(read())
    window.addEventListener(EVENT, sync)
    return () => window.removeEventListener(EVENT, sync)
  }, [])
  if (choice !== null) return null
  return (
    <div className="consent" role="dialog" aria-label="Cookie consent" aria-live="polite">
      <p className="consent__text t-small">
        We use cookies for anonymous analytics to improve Dojo. Accept to allow them, or decline to
        keep them off. See our <a href="/privacy">privacy policy</a>.
      </p>
      <div className="consent__actions">
        <Button variant="outline" size="small" onClick={() => choose('denied')}>
          Decline
        </Button>
        <Button variant="primary" size="small" onClick={() => choose('granted')}>
          Accept
        </Button>
      </div>
    </div>
  )
}
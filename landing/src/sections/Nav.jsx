import { useEffect, useRef, useState } from 'react'
import StarButton from '../components/StarButton.jsx'
import Logo from '../components/Logo.jsx'
import { Button } from '../components/ui.jsx'
import { SIGN_IN_URL, SIGN_UP_URL } from '../lib/product.js'

/* Hide the bar on the way down, bring it back the moment you scroll up.
   Never hides near the top, and small jitter is ignored so it doesn't flicker. */
function useHideOnScrollDown() {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let last = window.scrollY
    let frame = 0

    const update = () => {
      frame = 0
      const y = window.scrollY
      const delta = y - last
      if (Math.abs(delta) < 6) return
      setHidden(delta > 0 && y > 120)
      last = y
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return hidden
}

/* `#…` links scroll within the page; anything else is a normal navigation.
   Each page passes its own set, since the section anchors only exist on home. */
export const HOME_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '/grading-services', label: 'CGC grading' },
]

export default function Nav({ links = HOME_LINKS, current }) {
  const hidden = useHideOnScrollDown()
  const [open, setOpen] = useState(false)
  const burger = useRef(null)

  // escape closes the sheet and hands focus back to the control that opened it
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      burger.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // the sheet owns the viewport while it's up — the page behind it holds still
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // widening past the breakpoint retires the sheet along with the burger
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 900px)')
    const sync = () => wide.matches && setOpen(false)
    wide.addEventListener('change', sync)
    return () => wide.removeEventListener('change', sync)
  }, [])

  // in-page anchors scroll smoothly; page links fall through to the browser
  const go = (e, href) => {
    setOpen(false)
    if (!href.startsWith('#')) return
    e.preventDefault()
    document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <header className={`nav ${hidden && !open ? 'nav--hidden' : ''}`}>
      <div className="container nav__inner">
        <a className="nav__home" href="/" aria-label="Dojo — home">
          <Logo />
        </a>
        <div className="nav__right">
          {/* desktop only — below 900 these live in the sheet */}
          <nav className="nav__links" aria-label="Sections">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="nav__anchor"
                aria-current={l.href === current ? 'page' : undefined}
                onClick={(e) => go(e, l.href)}
              >
                {l.label}
              </a>
            ))}
          </nav>

          <StarButton className="nav__cta" href={SIGN_IN_URL}>
            Log in
          </StarButton>
          <StarButton className="nav__cta" href={SIGN_UP_URL}>
            Sign up
          </StarButton>

          {/* mobile only — the CTA moves inside the sheet */}
          <button
            ref={burger}
            type="button"
            className={`nav__burger ${open ? 'is-open' : ''}`}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="nav-menu"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="nav__burger-bars" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div id="nav-menu" className="nav__menu">
          <nav className="container nav__menu-inner" aria-label="Main">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="t-caps-lg nav__link"
                aria-current={l.href === current ? 'page' : undefined}
                onClick={(e) => go(e, l.href)}
              >
                <span className="glyph-gold" aria-hidden="true">◆</span>
                {l.label}
              </a>
            ))}
            <div className="nav__menu-cta">
              <Button variant="primary" size="big" fullWidth showArrow href={SIGN_IN_URL}>
                Log in
              </Button>
              <Button variant="primary" size="big" fullWidth showArrow href={SIGN_UP_URL}>
                Sign up
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  )
}

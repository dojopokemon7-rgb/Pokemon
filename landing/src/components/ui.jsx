/* Dojo primitives — Button (plunk), Tag, ElevatedCard */

import { useEffect, useRef, useState } from 'react'

export function Button({
  variant = 'primary',
  size = 'big',
  fullWidth = false,
  disabled = false,
  showArrow = false,
  shimmerOnView = false,
  children,
  onClick,
  href,
  type = 'button',
}) {
  // with an href it's a link wearing the button — same plunk, real navigation
  const El = href ? 'a' : 'button'

  // gloss sweep — restarts by remounting the band on each hover/press
  const [sweep, setSweep] = useState(0)
  const ref = useRef(null)
  const fire = () => { if (!disabled) setSweep((n) => n + 1) }
  const outlined = variant === 'outline'

  /* one unprompted sweep the first time the button comes into view — the same
     gloss as hover, fired once and then the observer lets go for good */
  useEffect(() => {
    if (!shimmerOnView || disabled) return
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        io.disconnect()
        setSweep((n) => n + 1)
      },
      { threshold: 0.6 }
    )

    io.observe(el)
    return () => io.disconnect()
  }, [shimmerOnView, disabled])

  return (
    <El
      ref={ref}
      {...(href ? { href } : { type, disabled })}
      className={`dojo-btn dojo-btn--${variant} dojo-btn--${size} ${fullWidth ? 'dojo-btn--full' : ''}`}
      onClick={(e) => { fire(); onClick && onClick(e) }}
      onPointerEnter={fire}
    >
      {!disabled && !outlined && (
        <span key={`shine-${sweep}`} className={`dojo-btn__shine ${sweep > 0 ? 'is-sweeping' : ''}`} aria-hidden="true" />
      )}
      {!disabled && sweep > 0 && (
        <span key={`glow-${sweep}`} className="dojo-btn__glow" aria-hidden="true" />
      )}
      <span className="dojo-btn__label">{children}</span>
      {showArrow && (
        <svg
          className="dojo-btn__arrow"
          width="24"
          height="10"
          viewBox="0 0 24 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M0 5h22M18 1l4 4-4 4" strokeLinecap="square" />
        </svg>
      )}
    </El>
  )
}

export function Tag({ type = 'neutral', subtle = false, children }) {
  return (
    <span className={`dojo-tag dojo-tag--${type} ${subtle ? 'dojo-tag--subtle' : ''}`}>
      {children}
    </span>
  )
}

export function ElevatedCard({
  backgroundColor,
  plunk = 'sm',
  bordered = false,
  accent = false,
  padding,
  className = '',
  style,
  children,
}) {
  return (
    <div
      className={`dojo-card dojo-card--${plunk} ${accent ? 'dojo-card--accent' : ''} ${bordered ? 'dojo-card--bordered' : ''} ${className}`}
      style={{ backgroundColor, padding, ...style }}
    >
      {children}
    </div>
  )
}

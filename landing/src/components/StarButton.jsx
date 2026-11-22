/*
 * Outlined button — silver hairline, gradient label, no motion.
 *
 * Ported from the shadcn/Tailwind original, which ran a light around the
 * outline on an offset-path. That treatment has been removed; what's left is
 * the plain bordered face. Given an href it renders as a link.
 */

export default function StarButton({
  children,
  faceColor = 'var(--ink-900)',
  borderWidth = 1,
  radius = 0,
  className = '',
  onClick,
  href,
  type = 'button',
}) {
  const El = href ? 'a' : 'button'

  return (
    <El
      {...(href ? { href } : { type })}
      onClick={onClick}
      className={`star-btn ${className}`}
      style={{
        '--face-color': faceColor,
        '--star-border-width': `${borderWidth}px`,
        '--star-radius': `${radius}px`,
      }}
    >
      <span className="star-btn__label">{children}</span>
    </El>
  )
}

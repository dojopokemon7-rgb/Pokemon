import { useEffect, useId, useRef, useState } from 'react'

/*
 * Isometric "plunk" marks — bell, shield, star, bubble.
 * Ported from "Neon Bell Mark.dc.html" in the claude.ai/design project
 * bee2f4a9-2e89-47b1-9fe4-0549f7e30621 (Dojo Design System v2).
 *
 * Build order per mark: a depth block offset down-right, the face on top with a
 * hard black cut, then a diagonal light band clipped to the face. Everything is
 * tilted -7° except the bell, whose paths are drawn pre-tilted.
 */

const SHAPES = {
  bubble: {
    tilt: 'rotate(-7 350 380)',
    body: ['M128 526 A290 290 0 1 1 325 629 L140 730 Z'],
    band: 'M596 92 L634 194 L96 574 L30 496 Z',
    join: 'miter',
  },
  star: {
    tilt: 'rotate(-7 350 380)',
    body: ['M350 34 L456 260 L700 296 L522 470 L566 714 L350 592 L134 714 L178 470 L0 296 L244 260 Z'],
    band: 'M628 118 L664 214 L96 570 L34 498 Z',
    join: 'miter',
  },
  shield: {
    tilt: 'rotate(-7 340 380)',
    body: ['M60 128 L340 38 L620 128 L620 396 C620 542 498 636 340 702 C182 636 60 542 60 396 Z'],
    band: 'M596 96 L628 190 L96 520 L36 452 Z',
    join: 'round',
    // the check is cut into the face in the depth colour
    mark: 'M215 372 L305 468 L487 282',
  },
  bell: {
    tilt: null,
    body: [
      'M26 438 C78 392 138 300 178 202 C220 100 300 40 396 46 C496 52 588 158 608 302 C624 412 612 520 612 612 C470 612 190 530 26 438 Z',
      'M26 438 C190 530 470 612 612 612 L612 650 C470 650 175 566 10 470 L26 438 Z',
    ],
    // clapper + crown, drawn with the body
    extras: [
      { el: 'ellipse', cx: 466, cy: 36, rx: 36, ry: 34 },
      { el: 'circle', cx: 292, cy: 634, r: 72 },
    ],
    band: 'M596 100 L624 190 L72 524 L2 460 Z',
    join: 'round',
  },
}

/* The colourways live in components.css as `.plunk-mark--<way>` rules feeding
   --pm-face / --pm-band / --pm-depth. Keeping them in CSS is what lets the
   mobile monochrome ways override them; an inline style could not be. */

function Extras({ extras, fill }) {
  if (!extras) return null
  return extras.map((e, i) =>
    e.el === 'ellipse' ? (
      <ellipse key={i} cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} fill={fill} />
    ) : (
      <circle key={i} cx={e.cx} cy={e.cy} r={e.r} fill={fill} />
    )
  )
}

export default function PlunkMark({ shape, colourway = 'gold', size = 88, label }) {
  const s = SHAPES[shape]
  const uid = useId().replace(/:/g, '')
  const clipId = `plunk-${uid}`
  const glossId = `plunk-gloss-${uid}`
  const ref = useRef(null)
  const onScreen = useRef(false)
  const [sweep, setSweep] = useState(0)

  /* A sheen every time the mark comes back on screen, so the observer stays
     connected for the life of the component. The two thresholds give it
     hysteresis — it fires at 60% visible and only rearms once the mark has
     essentially left — so scrolling that hovers around the trigger point
     can't set it off repeatedly. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const io = new IntersectionObserver(
      ([entry]) => {
        const ratio = entry.intersectionRatio
        if (!onScreen.current && ratio >= 0.6) {
          onScreen.current = true
          setSweep((n) => n + 1)
        } else if (onScreen.current && ratio <= 0.05) {
          onScreen.current = false
        }
      },
      { threshold: [0, 0.05, 0.6] }
    )

    io.observe(el)
    return () => io.disconnect()
  }, [])

  const faces = (
    <>
      {/* depth block, offset down-right — never blurred, always a hard cut */}
      <g transform="translate(20,22)" fill="var(--pm-depth)">
        <Extras extras={s.extras} fill="var(--pm-depth)" />
        {s.body.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      <g stroke="#000000" strokeWidth="5" strokeLinejoin={s.join}>
        <Extras extras={s.extras} fill="var(--pm-face)" />
        {s.body.map((d) => (
          <path key={d} d={d} fill="var(--pm-face)" />
        ))}
      </g>

      {/* one diagonal band of light, clipped to the face */}
      <g clipPath={`url(#${clipId})`}>
        <path d={s.band} fill="var(--pm-band)" />
      </g>

      {s.mark && (
        <path d={s.mark} stroke="var(--pm-depth)" strokeWidth="58" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
      )}

      {/* Sheen, clipped to the face like the band. The group is turned to the
          same 50° the design band sits on, so the sheen runs parallel to it and
          sweeps across perpendicular. Parked off the face until it runs, and
          remounted on each sweep so the animation replays. */}
      <g clipPath={`url(#${clipId})`}>
        <g transform="rotate(50 350 380)">
          <rect
            key={`gloss-${sweep}`}
            className={`plunk-mark__gloss ${sweep > 0 ? 'is-sweeping' : ''}`}
            x="-350"
            y="-220"
            width="200"
            height="1200"
            fill={`url(#${glossId})`}
          />
        </g>
      </g>
    </>
  )

  return (
    <svg
      ref={ref}
      className={`plunk-mark plunk-mark--${colourway}`}
      width={size}
      height={Math.round((size * 760) / 700)}
      viewBox="0 0 700 760"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={label}
    >
      <defs>
        <clipPath id={clipId}>
          {s.body.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
        <linearGradient id={glossId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {s.tilt ? <g transform={s.tilt}>{faces}</g> : faces}
    </svg>
  )
}

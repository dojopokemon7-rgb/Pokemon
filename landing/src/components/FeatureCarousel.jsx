import { useCallback, useEffect, useRef, useState } from 'react'

/*
 * The four app screens as one swipeable rail — mobile only, sitting under the
 * feature stack once every card has been scrolled through.
 *
 * It advances on its own, but the swipe is always the authority: scroll-snap
 * owns the motion, and any touch, drag or dot press holds the timer off for a
 * spell so an auto-advance can never yank a slide out from under a thumb.
 * It also idles whenever the rail is off screen or the tab is hidden.
 *
 * The first move lands shortly after the rail scrolls into view rather than a
 * full interval later — otherwise arriving just after a tick means staring at
 * a still image for seconds, with nothing to say it can be swiped.
 */

const ADVANCE_MS = 2600
const FIRST_MOVE_MS = 650
const HOLD_AFTER_TOUCH_MS = 6000

export default function FeatureCarousel({ items }) {
  const rail = useRef(null)
  const [active, setActive] = useState(0)
  const activeRef = useRef(0)
  const holdUntil = useRef(0)
  const onScreen = useRef(false)

  const scrollToIndex = useCallback((i) => {
    const el = rail.current
    const slide = el?.children[i]
    if (!slide) return
    el.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' })
  }, [])

  const hold = useCallback(() => {
    holdUntil.current = performance.now() + HOLD_AFTER_TOUCH_MS
  }, [])

  // whichever slide's centre is nearest the rail's centre is the live one
  useEffect(() => {
    const el = rail.current
    if (!el) return
    let frame = 0

    const update = () => {
      frame = 0
      const mid = el.scrollLeft + el.clientWidth / 2
      let best = 0
      let bestDist = Infinity
      for (const [i, slide] of [...el.children].entries()) {
        const dist = Math.abs(slide.offsetLeft + slide.offsetWidth / 2 - mid)
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      }
      activeRef.current = best
      setActive(best)
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // auto-advance, yielding to the user and to being off screen
  useEffect(() => {
    const el = rail.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let timer = 0

    /* Self-rescheduling rather than a bare interval, so the wait before the
       first move can be short while the cadence after it stays steady. A held
       turn is skipped but still keeps the rhythm. */
    const queue = (delay) => {
      timer = setTimeout(() => {
        if (!document.hidden && performance.now() >= holdUntil.current) {
          scrollToIndex((activeRef.current + 1) % items.length)
        }
        queue(ADVANCE_MS)
      }, delay)
    }

    const start = () => {
      if (timer) return
      queue(FIRST_MOVE_MS)
    }

    const stop = () => {
      clearTimeout(timer)
      timer = 0
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.intersectionRatio >= 0.35
        if (visible === onScreen.current) return
        onScreen.current = visible
        if (visible) start()
        else stop()
      },
      { threshold: [0, 0.35] }
    )
    io.observe(el)

    // a finger on the rail parks the timer; so does a trackpad swipe
    for (const evt of ['pointerdown', 'touchstart', 'wheel']) {
      el.addEventListener(evt, hold, { passive: true })
    }

    return () => {
      stop()
      io.disconnect()
      for (const evt of ['pointerdown', 'touchstart', 'wheel']) {
        el.removeEventListener(evt, hold)
      }
    }
  }, [items.length, scrollToIndex, hold])

  const goTo = (i) => {
    hold()
    scrollToIndex(i)
  }

  return (
    <div className="fcar">
      <div className="fcar__rail" ref={rail}>
        {items.map((it) => (
          <div className="fcar__slide" key={it.n}>
            {it.media}
            <p className="t-caps fcar__caption">
              <span className="num">{it.n}</span> {it.title}
            </p>
          </div>
        ))}
      </div>

      {/* plain buttons, not a tablist — there are no tabpanels to pair them with */}
      <div className="fcar__dots" role="group" aria-label="App screens">
        {items.map((it, i) => (
          <button
            key={it.n}
            type="button"
            aria-label={`Show ${it.title}`}
            aria-current={i === active}
            className={`fcar__dot ${i === active ? 'is-active' : ''}`}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
    </div>
  )
}

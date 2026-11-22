import { useCallback, useEffect, useRef, useState } from 'react'
import receivingImg from '../assets/grading/process/receiving.webp'
import verificationImg from '../assets/grading/process/verification.webp'
import authenticationImg from '../assets/grading/process/authentication.webp'
import gradingImg from '../assets/grading/process/grading.webp'
import encapsulationImg from '../assets/grading/process/encapsulation.webp'
import imagingImg from '../assets/grading/process/imaging.webp'
import qualityImg from '../assets/grading/process/quality-control.webp'
import packagingImg from '../assets/grading/process/packaging.webp'

/*
 * The eight stages a card goes through at CGC, as one rail. Scroll-snap owns
 * the motion, so a swipe on a phone and the arrows / stage bar on desktop all
 * move the same thing, and whichever slide sits at the rail's left edge is the
 * live one. No auto-advance — every stage is read at the reader's pace.
 */

const STEPS = [
  {
    title: 'Receiving',
    img: receivingImg,
    alt: 'A scanner reading the barcode on a CGC submission packing slip',
    body: 'CGC staff open each submission on camera and check it against its paperwork. It’s then logged in CGC’s tracking system under its own submission number.',
  },
  {
    title: 'Verification',
    img: verificationImg,
    alt: 'A CGC staff member checking a card against its record on screen',
    body: 'Every card is checked against the description it was submitted with and given its own barcode. From here the card travels without its paperwork, so graders never know whose it is.',
  },
  {
    title: 'Authentication',
    img: authenticationImg,
    alt: 'A card lit from behind during authentication',
    body: 'Cards wait in CGC’s vault until they’re examined for authenticity. A card that can’t be confirmed genuine isn’t graded.',
  },
  {
    title: 'Grading',
    img: gradingImg,
    alt: 'A grader examining a card through a loupe',
    body: 'Several CGC graders examine each card, helped by specialist equipment, and each records a grade on their own. The final grade is agreed between them. Cards are graded by specialists in their category.',
  },
  {
    title: 'Encapsulation',
    img: encapsulationImg,
    alt: 'Two graded cards sealed in clear CGC holders',
    body: 'The card is sealed in a clear CGC holder with a label showing its description, grade, certification number and a QR code. Security features in the holder and label guard against tampering and fakes.',
  },
  {
    title: 'Imaging',
    img: imagingImg,
    alt: 'A graded card in its holder in front of an imaging screen',
    body: 'Every graded card is photographed in its holder. Anyone can pull up those images at any time with CGC’s certification lookup.',
  },
  {
    title: 'Quality control',
    img: qualityImg,
    alt: 'A specialist inspecting a sealed CGC holder',
    body: 'A quality control specialist inspects the card, label and holder one last time, checking every detail and looking for any defect.',
  },
  {
    title: 'Packing & shipping',
    img: packagingImg,
    alt: 'Graded cards packed in a box with protective wrap',
    body: 'Cards are counted against the original paperwork, packed securely and shipped back to Dojo — and from us, on to you.',
  },
]

const pad = (n) => String(n).padStart(2, '0')

function Chevron({ dir }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d={dir === 'prev' ? 'M11 3 5 9l6 6' : 'm7 3 6 6-6 6'} strokeLinecap="square" />
    </svg>
  )
}

export default function GradingProcess() {
  const rail = useRef(null)
  const [active, setActive] = useState(0)

  // the slide whose left edge sits nearest the rail's is the live one
  useEffect(() => {
    const el = rail.current
    if (!el) return
    let frame = 0
    const update = () => {
      frame = 0
      let best = 0
      let bestD = Infinity
      ;[...el.children].forEach((slide, i) => {
        const d = Math.abs(slide.offsetLeft - el.scrollLeft)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      setActive(best)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const goTo = useCallback((i) => {
    const el = rail.current
    if (!el) return
    const n = el.children.length
    const slide = el.children[(i + n) % n]
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ left: slide.offsetLeft, behavior: still ? 'auto' : 'smooth' })
  }, [])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      goTo(active + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goTo(active - 1)
    }
  }

  return (
    <div className="gproc" role="region" aria-roledescription="carousel" aria-label="The CGC grading process">
      <div className="gproc__rail" ref={rail} tabIndex={0} onKeyDown={onKeyDown}>
        {STEPS.map((s, i) => (
          <article
            key={s.title}
            className="gproc__slide"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${STEPS.length}: ${s.title}`}
          >
            <div className="gproc__media">
              <img src={s.img} alt={s.alt} width="586" height="403" loading="lazy" decoding="async" />
            </div>
            <div className="gproc__text">
              <p className="t-caps gproc__count">
                <span className="num gproc__count-now">{pad(i + 1)}</span>
                <span className="num"> / {pad(STEPS.length)}</span>
              </p>
              <h3 className="gproc__title">{s.title}</h3>
              <p className="gproc__body">{s.body}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="gproc__controls">
        <button type="button" className="gproc__arrow" aria-label="Previous stage" onClick={() => goTo(active - 1)}>
          <Chevron dir="prev" />
        </button>

        <ol className="gproc__stages">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <button
                type="button"
                className={`gproc__stage ${i <= active ? 'is-reached' : ''}`}
                aria-label={`Stage ${i + 1}: ${s.title}`}
                aria-current={i === active ? 'step' : undefined}
                onClick={() => goTo(i)}
              >
                <span className="gproc__stage-bar" aria-hidden="true" />
                <span className="t-caps gproc__stage-label" aria-hidden="true">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>

        <button type="button" className="gproc__arrow" aria-label="Next stage" onClick={() => goTo(active + 1)}>
          <Chevron dir="next" />
        </button>
      </div>
    </div>
  )
}

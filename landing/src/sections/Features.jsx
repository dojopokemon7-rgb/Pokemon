import { useEffect, useRef } from 'react'
import PlunkMark from '../components/PlunkMark.jsx'
import FeatureCarousel from '../components/FeatureCarousel.jsx'
import FloorScreen from '../components/FloorScreen.jsx'
import StoreScreen from '../components/StoreScreen.jsx'
import EventsScreen from '../components/EventsScreen.jsx'
import TriggersScreen from '../components/TriggersScreen.jsx'
import useMediaQuery from '../hooks/useMediaQuery.js'

/* As the next card slides over a stuck one, the card behind recedes — scales
   down from its pinned top edge and dims. Runs at every width now that the
   mobile card is text only; off under reduced motion, where the CSS sticky
   stack is off too and the cards just run in normal flow. */
function useStackDepth(ref) {
  useEffect(() => {
    const stack = ref.current
    if (!stack) return

    const still = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0

    const reset = () => {
      for (const card of stack.children) {
        card.style.transform = ''
        card.style.filter = ''
      }
    }

    const update = () => {
      frame = 0
      const cards = [...stack.children]
      cards.forEach((card, i) => {
        const next = cards[i + 1]
        if (!next) {
          card.style.transform = ''
          card.style.filter = ''
          return
        }
        // 0 while the next card is still clear of this one, 1 once it covers it
        const top = card.getBoundingClientRect().top
        const covered = 1 - (next.getBoundingClientRect().top - top) / card.offsetHeight
        const p = Math.min(Math.max(covered, 0), 1)
        if (p === 0) {
          // untouched cards keep a clean style attribute — no no-op filter
          card.style.transform = ''
          card.style.filter = ''
          return
        }
        card.style.transform = `scale(${(1 - p * 0.07).toFixed(4)})`
        card.style.filter = `brightness(${(1 - p * 0.4).toFixed(4)})`
      })
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    const sync = () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (!still.matches) {
        window.addEventListener('scroll', onScroll, { passive: true })
        window.addEventListener('resize', onScroll)
        update()
      } else {
        reset()
      }
    }

    sync()
    still.addEventListener('change', sync)

    return () => {
      still.removeEventListener('change', sync)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref])
}

/* Each app screen (390×844) rendered inside an iPhone device frame,
   scaled down to sit beside its copy. */
function PhoneFrame({ label, children }) {
  return (
    <div className="design-phone">
      <div className="design-phone__scale">
        <div className="phone-frame" role="img" aria-label={label}>
          {/* inert: mockup UI must not be focusable — the frame is one labelled image */}
          <div className="phone-frame__screen" inert="">{children}</div>
          <div className="phone-frame__island" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

const FEATURES = [
  {
    n: '01',
    mark: { shape: 'shield', colourway: 'gold', label: 'Verified shield mark' },
    title: 'DOJO TRUSTED STORES',
    body: 'Dojo verifies every store before it goes live, so you get exactly what you pay for. Buying a card should feel like walking into a shop you already know.',
    points: ['every store is KYC verified', 'see what people actually pay', 'every sale on the record'],
    media: (
      <PhoneFrame label="verified store listing — Charizard ex at Slabs and Foils, Mumbai">
        <StoreScreen />
      </PhoneFrame>
    ),
  },
  {
    n: '02',
    mark: { shape: 'bubble', colourway: 'jade', label: 'Trading floor bubble mark' },
    title: 'THE TRADING FLOOR',
    body: 'Post what you want to buy or sell, and the right collector comes to you. You deal direct, and get to connect with them before you agree to anything.',
    points: ['post what you want in seconds', 'Trade with community verified users', 'trade cards, not just cash'],
    media: (
      <PhoneFrame label="trading floor — live want-to-buy and want-to-sell listings">
        <FloorScreen />
      </PhoneFrame>
    ),
  },
  {
    n: '03',
    mark: { shape: 'star', colourway: 'chalk', label: 'Events star mark' },
    title: 'EVENTS NEAR YOU',
    body: 'Find TCG events, meetups and tournaments happening near you, see who else is going, and turn up knowing someone. Collecting is better in person.',
    points: ['Find IRL events and join the community', 'see who’s going', 'rsvp in a tap'],
    media: (
      <PhoneFrame label="events near you — leagues, meets and tournaments with city filters">
        <EventsScreen />
      </PhoneFrame>
    ),
  },
  {
    n: '04',
    mark: { shape: 'bell', colourway: 'electric', label: 'Price trigger bell mark' },
    title: 'PRICE TRIGGERS',
    body: 'Set your price and let Dojo monitor and alert you the moment your asking price matches.',
    points: ['set a buy or sell price', 'we monitor so you don’t have to', 'get trigger alerts once the prices match'],
    media: (
      <PhoneFrame label="price triggers — a hit target and three armed triggers with proximity meters">
        <TriggersScreen />
      </PhoneFrame>
    ),
  },
]

export default function Features() {
  const stack = useRef(null)
  useStackDepth(stack)
  /* mobile cards carry the copy alone — the screens regroup into the carousel
     below, so each phone is mounted once either way */
  const mobile = useMediaQuery('(max-width: 899px)')

  return (
    <section className="features" id="features">
      <div className="container">
        <div className="features__stack" ref={stack}>
          {FEATURES.map((f, i) => (
            <div key={f.n} className={`feature-row ${i % 2 ? 'feature-row--flip' : ''}`}>
              <div className="feature-row__text">
                <div className="feature__head">
                  <span className="t-caps feature__num num">{f.n}</span>
                </div>
                {/* the mark sits over the head of the copy, flush with it */}
                <PlunkMark {...f.mark} size={67} />
                <h3 className="feature__title">{f.title}</h3>
                <p className="feature__body">{f.body}</p>
                <ul className="feature__points">
                  {f.points.map((p) => (
                    <li key={p}>
                      <span className="glyph-gold" aria-hidden="true">◆</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {!mobile && <div className="feature-row__phone">{f.media}</div>}
            </div>
          ))}
        </div>

        {mobile && <FeatureCarousel items={FEATURES} />}
      </div>
    </section>
  )
}

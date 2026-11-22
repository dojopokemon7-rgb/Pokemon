import { Button } from '../components/ui.jsx'
import { SIGN_UP_URL } from '../lib/product.js'
import PortfolioScreen from '../components/PortfolioScreen.jsx'
import Floating, { FloatingElement } from '../components/ParallaxFloating.jsx'
import charizardImg from '../assets/floor/charizard.webp'
import gengarImg from '../assets/floor/gengar.webp'
import luffyImg from '../assets/floor/luffy.webp'
import zoroImg from '../assets/floor/zoro.jpg'

/* cards drifting around the hero phone — parallax against the pointer */
const FLOATS = [
  { src: charizardImg, alt: 'Charizard ex card', cls: 'hero-float--tl', depth: 1.2 },
  { src: gengarImg, alt: 'Mega Gengar ex card', cls: 'hero-float--tr', depth: 0.7 },
  { src: zoroImg, alt: 'Roronoa Zoro graded slab', cls: 'hero-float--bl', depth: 2 },
  { src: luffyImg, alt: 'Monkey D. Luffy card', cls: 'hero-float--br', depth: 1.5 },
]

export default function Hero({ cap }) {
  const invitedBy = new URLSearchParams(window.location.search).get('ref')

  return (
    <section className="hero">
      <div className="container hero__grid">
        <div className="hero__copy">
          {invitedBy && (
            <p className="t-caps hero__invited">
              <span className="num">{invitedBy}</span> INVITED YOU
            </p>
          )}
          <h1 className="hero__title">
            Track your collectibles and buy from{' '}
            <span className="hero__title-accent">trusted stores.</span>
          </h1>
          {/* one paragraph, not three stacked fragments — it sets in two lines */}
          <p className="t-body-md hero__sub">
            See what your One Piece and Pokémon cards are worth, updated daily. Trade,
            connect and buy from trusted users online.
          </p>

          {/* CTA rides with the copy so it lands above the fold, no scroll needed */}
          <div className="hero__cta">
            <Button variant="primary" size="big" href={SIGN_UP_URL} showArrow shimmerOnView>
              Sign up
            </Button>
            <p className="t-caps hero__limit">
              FOUNDING BADGE FOR THE FIRST <span className="num">{cap}</span> COLLECTORS
            </p>
          </div>
        </div>

        <div className="hero__phone">
          <Floating sensitivity={-1} className="hero-floating" aria-hidden="true">
            {FLOATS.map((f, i) => (
              <FloatingElement key={f.cls} depth={f.depth} className={`hero-float ${f.cls}`}>
                <img src={f.src} alt="" className="hero-float__card" style={{ animationDelay: `${0.3 + i * 0.15}s` }} />
              </FloatingElement>
            ))}
          </Floating>
          <div className="design-phone design-phone--hero">
            <div className="design-phone__scale">
              <div className="phone-frame phone-frame--hero" role="img" aria-label="dojo portfolio home — ₹8,42,660 portfolio value, up 12.4% this month">
                {/* inert: mockup UI must not be focusable — the frame is one labelled image */}
                <div className="phone-frame__screen" inert="">
                  <PortfolioScreen />
                </div>
                <div className="phone-frame__island" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

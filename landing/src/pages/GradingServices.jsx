import BeamsBackground from '../components/BeamsBackground.jsx'
import Floating, { FloatingElement } from '../components/ParallaxFloating.jsx'
import GradingProcess from '../components/GradingProcess.jsx'
import NotifyForm from '../components/NotifyForm.jsx'
import { Button } from '../components/ui.jsx'
import { SIGN_IN_URL, SIGN_UP_URL } from '../lib/product.js'
import Nav from '../sections/Nav.jsx'
import Footer from '../sections/Footer.jsx'
import dealerLogo from '../assets/grading/logos/cgc-authorized-dealer.webp'
import charizardSlab from '../assets/grading/slabs/charizard-pristine-10.webp'
import luffySlab from '../assets/grading/slabs/luffy-10.webp'
import umbreonSlab from '../assets/grading/slabs/umbreon-10.webp'
import amazingFantasySlab from '../assets/grading/slabs/amazing-fantasy-15.webp'
import supermanSlab from '../assets/grading/slabs/superman-1.webp'
import graderPhoto from '../assets/grading/grading-hero.webp'
import scaleImg from '../assets/grading/grading-scale.webp'
import guaranteeImg from '../assets/grading/cgc-guarantee.webp'
import hologramTexture from '../assets/grading/hologram-texture.webp'

/*
 * CGC grading services — announces Dojo as a CGC Authorized Dealer and
 * collects interest ahead of mail-in submissions opening. Its own Vite entry
 * (grading-services.html), served at /grading-services.
 *
 * Slab photos, logos and process imagery are CGC's approved dealer assets.
 */

const PAGE_LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/grading-services', label: 'CGC grading' },
]

/* back row is the comics, the front row the cards — depth drives both the
   parallax travel and the stacking */
const SLABS = [
  { src: amazingFantasySlab, alt: 'Amazing Fantasy #15 in a CGC 9.6 holder', cls: 'gslab--back-l', depth: 0.6 },
  { src: supermanSlab, alt: 'Superman #1 in a CGC 8.0 holder', cls: 'gslab--back-r', depth: 0.6 },
  { src: luffySlab, alt: 'Monkey D. Luffy card graded CGC 10', cls: 'gslab--mid-l', depth: 1.2 },
  { src: umbreonSlab, alt: 'Umbreon VMAX card graded CGC 10', cls: 'gslab--mid-r', depth: 1.2 },
  { src: charizardSlab, alt: '1999 Charizard graded CGC Pristine 10', cls: 'gslab--front', depth: 2 },
]

const SCALE_LINKS = [
  { href: 'https://www.cgccards.com/card-grading/grading-scale/', label: 'Card grading scale' },
  { href: 'https://www.cgccomics.com/grading/grading-scale/', label: 'Comic grading scale' },
]

const GUARANTEE_LINKS = [
  { href: 'https://www.cgccards.com/card-grading/cgc-guarantee/', label: 'Cards guarantee' },
  { href: 'https://www.cgccomics.com/grading/cgc-guarantee/', label: 'Comics guarantee' },
]

function scrollToNotify(e) {
  const target = document.getElementById('notify')
  if (!target) return
  e.preventDefault()
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: still ? 'auto' : 'smooth' })
  // land focus in the form so a keyboard user carries on from where they read
  setTimeout(() => document.getElementById('notify-email')?.focus({ preventScroll: true }), still ? 0 : 600)
}

function ExternalLinks({ links }) {
  return (
    <ul className="glinks">
      {links.map((l) => (
        <li key={l.href}>
          <a className="glink" href={l.href} target="_blank" rel="noopener noreferrer">
            {l.label}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M2 8 8 2M3.5 2H8v4.5" strokeLinecap="square" />
            </svg>
            <span className="sr-only"> (opens CGC’s site)</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function Hero() {
  return (
    <section className="ghero">
      <div className="container ghero__grid">
        <div className="ghero__copy">
          <img
            className="ghero__dealer"
            src={dealerLogo}
            alt="CGC Authorized Dealer"
            width="900"
            height="358"
          />
          <h1 className="hero__title ghero__title">
            Get your cards and comics <span className="hero__title-accent">graded by CGC.</span>
          </h1>
          <p className="t-body-md hero__sub">
            Dojo is now a CGC Authorized Dealer, and mail-in submissions open soon. Send your cards
            and comics to Dojo, we submit them to CGC, and they come back to you graded and sealed in
            a CGC holder.
          </p>
          <div className="hero__cta ghero__cta">
            <p className="t-caps ghero__status">
              <span className="glyph-gold" aria-hidden="true">◆</span> Mail-in submissions opening soon
            </p>
            <Button variant="primary" size="big" href="#notify" onClick={scrollToNotify} showArrow shimmerOnView>
              Notify me
            </Button>
            <p className="t-caps hero__limit">Pokémon · One Piece · TCGs · Comics</p>
          </div>
        </div>

        <div className="ghero__slabs">
          <Floating sensitivity={-1} className="ghero__floating">
            {SLABS.map((s, i) => (
              <FloatingElement key={s.cls} depth={s.depth} className={`gslab ${s.cls}`}>
                <img
                  src={s.src}
                  alt={s.alt}
                  className="gslab__img"
                  width="560"
                  height="946"
                  style={{ animationDelay: `${0.15 + i * 0.1}s` }}
                />
              </FloatingElement>
            ))}
          </Floating>
        </div>
      </div>
    </section>
  )
}

function WhyCgc() {
  return (
    <section className="gwhy">
      <div className="container">
        <div className="gwhy__panel">
          <div className="gwhy__media">
            <img src={graderPhoto} alt="A CGC grader examining a card through a loupe" width="1445" height="740" loading="lazy" decoding="async" />
          </div>
          <div className="gwhy__text">
            <p className="t-caps gsec__label">
              <span className="glyph-gold" aria-hidden="true">◆</span> Why CGC
            </p>
            <h2 className="gsec__title">Accurate, consistent, fast.</h2>
            <p className="gsec__body">
              CGC grades trading cards and comics for collectors and dealers around the world.
              Expert graders work alongside imaging and tracking technology, so every card gets a
              grade that’s accurate and consistent.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function Process() {
  return (
    <section className="gprocess" id="process">
      <div className="container">
        <div className="gsec__head">
          <p className="t-caps gsec__label">
            <span className="glyph-gold" aria-hidden="true">◆</span> The grading process
          </p>
          <h2 className="gsec__title">Eight stages, every card.</h2>
          <p className="gsec__body">
            Every card CGC grades goes through the same steps, built for accuracy, consistency and
            impartiality. Here’s what happens once Dojo hands yours over.
          </p>
        </div>
        <GradingProcess />
      </div>
    </section>
  )
}

/* What the tracker card shows. Kept to what CGC's dealer API actually hands
   back — a status while it's with CGC, the return tracking number, and the
   certified grades — plus Dojo's own legs either side. */
const TRACK_STEPS = [
  { label: 'Received at Dojo', note: 'Checked and logged', state: 'done' },
  { label: 'With CGC', note: 'Submitted for grading', state: 'done' },
  { label: 'Being graded', note: 'Status straight from CGC', state: 'now' },
  { label: 'Grades in', note: 'Grades and cert numbers', state: 'next' },
  { label: 'On its way back', note: 'Tracking number in Dojo', state: 'next' },
]

const TRACK_POINTS = [
  'Its status as it moves through CGC',
  'Your grades and cert numbers as soon as they’re in',
  'The tracking number the day it ships back',
]

function Track() {
  return (
    <section className="gtrack" id="track">
      <div className="container gtrack__grid">
        <div className="gtrack__copy">
          <p className="t-caps gsec__label">
            <span className="glyph-gold" aria-hidden="true">◆</span> Track your submission
          </p>
          <h2 className="gsec__title">We track it. You follow along.</h2>
          <p className="gsec__body">
            From the day your cards reach us to the day they’re back with you, we track your
            submission with CGC. Sign in to Dojo to see where it is at any time.
          </p>
          <ul className="gtrack__points">
            {TRACK_POINTS.map((p) => (
              <li key={p}>
                <span className="glyph-gold" aria-hidden="true">◆</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <div className="gtrack__cta">
            <Button variant="primary" size="big" href={SIGN_UP_URL} showArrow>
              Sign up to Dojo
            </Button>
            <Button variant="outline" size="big" href={SIGN_IN_URL}>
              Sign in
            </Button>
          </div>
        </div>

        <div
          className="gtrack__card"
          role="img"
          aria-label="Example submission in Dojo: received at Dojo, with CGC, now being graded. Grades and return tracking still to come."
        >
          <div className="gtrack__head">
            <span className="t-caps gtrack__kicker">Your submission</span>
            <span className="t-caps gtrack__tag">Example</span>
          </div>
          <p className="gtrack__count">
            <span className="num">12</span> cards
          </p>
          <p className="t-caps gtrack__meta">Mail-in · CGC</p>

          <ol className="gtrack__steps">
            {TRACK_STEPS.map((s) => (
              <li key={s.label} className={`gtrack__step is-${s.state}`}>
                <span className="gtrack__dot" aria-hidden="true" />
                <span className="gtrack__step-label">{s.label}</span>
                <span className="gtrack__step-note">{s.state === 'now' ? 'Now · ' : ''}{s.note}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function InfoRow({ label, title, children, img, imgAlt, imgW, imgH, links, flip }) {
  return (
    <div className={`ginfo ${flip ? 'ginfo--flip' : ''}`}>
      <div className="ginfo__media">
        <img src={img} alt={imgAlt} width={imgW} height={imgH} loading="lazy" decoding="async" />
      </div>
      <div className="ginfo__text">
        <p className="t-caps gsec__label">
          <span className="glyph-gold" aria-hidden="true">◆</span> {label}
        </p>
        <h2 className="gsec__title">{title}</h2>
        <p className="gsec__body">{children}</p>
        <ExternalLinks links={links} />
      </div>
    </div>
  )
}

function ScaleAndGuarantee() {
  return (
    <section className="gscale">
      <div className="container gscale__stack">
        <InfoRow
          label="The grading scale"
          title="What’s in a number."
          img={scaleImg}
          imgAlt="Four cards in CGC holders graded 10, 10, 9.5 and 9"
          imgW="1000"
          imgH="500"
          links={SCALE_LINKS}
        >
          CGC grades on a 10-point scale. At the very top is Pristine 10 — kept for the best of the
          best, and finished with CGC’s gold Pristine label.
        </InfoRow>
        <InfoRow
          label="The CGC guarantee"
          title="Backed by the CGC Guarantee."
          img={guaranteeImg}
          imgAlt="CGC authenticity guarantee seal"
          imgW="684"
          imgH="400"
          links={GUARANTEE_LINKS}
          flip
        >
          Every CGC-certified card is covered by the CGC Guarantee. In the rare case a certified
          card turns out not to be genuine, or to be overgraded, the guarantee sets out how it’s
          put right.
        </InfoRow>
      </div>
    </section>
  )
}

function Notify() {
  return (
    <section className="gnotify" id="notify" style={{ '--holo': `url(${hologramTexture})` }}>
      <div className="container">
        <div className="gnotify__card">
          <div className="gnotify__intro">
            <p className="t-caps final__kicker">
              <span className="glyph-gold" aria-hidden="true">◆</span> Mail-in opening soon
            </p>
            <h2 className="gnotify__title">Be first in line.</h2>
            <p className="gsec__body">
              Leave your email and tell us what you’d send. We’ll let you know the day mail-in
              submissions open, along with pricing and turnaround times.
            </p>
            <p className="gsec__body">
              Not on Dojo yet? Sign up too. It’s where you’ll track your submission once it’s in.
            </p>
          </div>
          <div className="gnotify__form">
            <NotifyForm />
          </div>
        </div>
      </div>
    </section>
  )
}

export default function GradingServices() {
  return (
    <>
      <BeamsBackground intensity="subtle" />
      <Nav links={PAGE_LINKS} current="/grading-services" />
      <main>
        <Hero />
        <WhyCgc />
        <Process />
        <Track />
        <ScaleAndGuarantee />
        <Notify />
      </main>
      <Footer />
    </>
  )
}

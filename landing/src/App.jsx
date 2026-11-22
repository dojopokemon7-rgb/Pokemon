import BeamsBackground from './components/BeamsBackground.jsx'
import GradingBanner from './components/GradingBanner.jsx'
import Nav from './sections/Nav.jsx'
import Hero from './sections/Hero.jsx'
import BackedBy from './sections/BackedBy.jsx'
import Features from './sections/Features.jsx'
import FinalCta from './sections/FinalCta.jsx'
import Footer from './sections/Footer.jsx'
import { FOUNDING_CAP } from './lib/product.js'

export default function App() {
  return (
    <>
      <BeamsBackground intensity="subtle" />
      <GradingBanner />
      <Nav />
      <main>
        <Hero cap={FOUNDING_CAP} />
        <BackedBy />
        <Features />
        <FinalCta />
      </main>
      <Footer />
    </>
  )
}

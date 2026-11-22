import { Button } from '../components/ui.jsx'
import { SIGN_UP_URL } from '../lib/product.js'

export default function FinalCta() {
  return (
    <section className="final" id="register">
      <div className="container final__inner">
        <p className="t-caps final__kicker">
          <span className="glyph-gold">◆</span> NOW LIVE
        </p>
        <h2 className="final__title">Start tracking your collection</h2>
        <Button variant="primary" size="big" href={SIGN_UP_URL} showArrow shimmerOnView>
          Sign up
        </Button>
      </div>
    </section>
  )
}

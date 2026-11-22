import Logo from '../components/Logo.jsx'
import Icon from '../components/Icon.jsx'

/* Three groups, not four loose items — the brand reads as one unit on the left,
   the links sit together in the middle, and the legal line closes it out.

   Everything here is deliberately quiet: the mark is the only thing with any
   weight, and the links earn their underline on hover rather than wearing one
   at rest. Instagram sits a step brighter than the policy link, which is the
   whole difference in emphasis between the two. */
export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div className="footer__brand">
          <Logo className="logo--sm" />
          <span className="t-small footer__line">Now live</span>
        </div>

        <nav className="footer__links" aria-label="Footer">
          <a className="t-small footer__link" href="/grading-services">
            CGC grading
          </a>
          <a className="t-small footer__link" href="/privacy">
            Privacy policy
          </a>
          <a className="t-small footer__link" href="/contact">
            Contact
          </a>
          <a
            className="t-small footer__link footer__social"
            href="https://www.instagram.com/collect.with.dojo"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="instagram" size={15} strokeWidth={1.75} />
            Follow @collect.with.dojo
          </a>
        </nav>

        <span className="t-small footer__meta">© 2026 Dojo</span>
      </div>
    </footer>
  )
}

import cgcLogo from '../assets/grading/logos/cgc.webp'

/* Slim band over the home page nav announcing the CGC dealership. The whole
   band is one link to the grading page. */
export default function GradingBanner() {
  return (
    <a className="gbanner" href="/grading-services">
      <span className="container gbanner__inner">
        <img className="gbanner__logo" src={cgcLogo} alt="CGC" width="700" height="171" />
        <span className="t-caps gbanner__text">
          Dojo is now a CGC Authorized Dealer
          <span className="gbanner__soon"> · Mail-in grading opening soon</span>
        </span>
        <span className="t-caps gbanner__cta">
          <span className="gbanner__cta-label">Learn more</span>
          <svg width="16" height="8" viewBox="0 0 16 8" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M0 4h14M11 1l3 3-3 3" strokeLinecap="square" />
          </svg>
        </span>
      </span>
    </a>
  )
}

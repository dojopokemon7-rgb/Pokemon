/* Credibility band — NODWIN's B2C properties.
   Continuous marquee: the row is rendered twice and the track translates -50%,
   so the loop is seamless. Pauses on hover; falls back to a static centered,
   wrapped row under prefers-reduced-motion.
   Logos run in their original colour — flattening them to white turned the filled
   marks (Comic Con, Planet Superheroes, AFK) into silhouette blobs.
   w/h are aspect-correct so the box has area before load (a 0-width box never
   trips lazy-loading) and so wide wordmarks and squarer marks read at the same
   optical weight rather than the same pixel height. */
// public/ files aren't rebased inside JS strings, so prefix the build's base (/landing/)
const base = import.meta.env.BASE_URL
const LOGOS = [
  { src: `${base}logos/nodwin.png`, alt: 'NODWIN Gaming', w: 79, h: 26 },
  { src: `${base}logos/comic-con-india.png`, alt: 'Comic Con India', w: 57, h: 34 },
  // wordmark ships black-on-white; recoloured to white so it reads on ink.
  // the orange mark is untouched — see dreamhack.png for the original
  { src: `${base}logos/dreamhack-white.png`, alt: 'DreamHack India', w: 78, h: 26 },
  { src: `${base}logos/nh7-weekender.png`, alt: 'NH7 Weekender', w: 38, h: 38 },
  { src: `${base}logos/planet-superheroes.png`, alt: 'Planet Superheroes', w: 57, h: 34 },
  { src: `${base}logos/trinity-gaming.png`, alt: 'Trinity Gaming', w: 78, h: 28 },
  { src: `${base}logos/afk-gaming.png`, alt: 'AFK Gaming', w: 57, h: 34 },
]

function LogoRow({ dup = false }) {
  return (
    <ul className={`backed__row ${dup ? 'backed__row--dup' : ''}`} aria-hidden={dup || undefined}>
      {LOGOS.map((l) => (
        <li key={l.src} className="backed__item">
          <img
            src={l.src}
            alt={dup ? '' : l.alt}
            width={l.w}
            height={l.h}
            loading="lazy"
            decoding="async"
            style={{ height: `${l.h}px` }}
          />
        </li>
      ))}
    </ul>
  )
}

export default function BackedBy() {
  return (
    <section className="backed" id="backed">
      <div className="container">
        {/* the line leads into the logos it names */}
        <p className="t-caps backed__label">BACKED BY THE TEAM WHO BUILT</p>
        <div className="backed__viewport">
          <div className="backed__track">
            <LogoRow />
            <LogoRow dup />
          </div>
        </div>
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'

/* Subscribes to a media query. Seeded from the real match so the first paint is
   already correct — no desktop layout flashing before the mobile one lands. */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}

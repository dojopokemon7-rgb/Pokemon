import { lazy, Suspense } from 'react'
// its own chunk — the banner is only needed until a choice is stored
const ConsentBanner = lazy(() => import('./ConsentBanner.jsx'))
export default function LazyConsentBanner() {
  return (
    <Suspense fallback={null}>
      <ConsentBanner />
    </Suspense>
  )
}
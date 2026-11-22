import { useEffect, useRef } from 'react'

/*
 * Phone tilt as a pointer substitute — reports a position in the same units as
 * useMousePositionRef (pixels within the container) so the parallax loop can
 * read either source without caring which.
 *
 * gamma is the left/right tilt, beta the front/back. Beta is measured from a
 * resting hold of ~45°, not from flat, since that's how a phone is held while
 * reading. `active` only flips true once real readings arrive, so desktop and
 * permission-denied devices fall back to the pointer untouched.
 */

// degrees of tilt that map to a full sweep across the container
const RANGE = 22
const REST_BETA = 45

const clamp = (n) => Math.min(Math.max(n, -1), 1)

export function useDeviceTiltRef(containerRef) {
  const tiltRef = useRef({ x: 0, y: 0, active: false })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.DeviceOrientationEvent) return
    // pointer devices keep the mouse behaviour
    if (!window.matchMedia('(pointer: coarse)').matches) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const handleOrientation = (ev) => {
      if (ev.gamma == null || ev.beta == null) return
      const rect = containerRef?.current?.getBoundingClientRect()
      const w = rect?.width || window.innerWidth
      const h = rect?.height || window.innerHeight

      // 0…w and 0…h, centred when the phone is held at rest
      tiltRef.current = {
        x: (w / 2) * (1 + clamp(ev.gamma / RANGE)),
        y: (h / 2) * (1 + clamp((ev.beta - REST_BETA) / RANGE)),
        active: true,
      }
    }

    let cleanup = () => {}

    const subscribe = () => {
      window.addEventListener('deviceorientation', handleOrientation)
      cleanup = () => window.removeEventListener('deviceorientation', handleOrientation)
    }

    // iOS 13+ only hands over readings after an explicit grant, and the request
    // has to originate in a user gesture — so ask on the first touch
    const needsPermission = typeof DeviceOrientationEvent.requestPermission === 'function'

    if (!needsPermission) {
      subscribe()
    } else {
      const ask = () => {
        window.removeEventListener('touchend', ask)
        DeviceOrientationEvent.requestPermission()
          .then((state) => {
            if (state === 'granted') subscribe()
          })
          .catch(() => {})
      }
      window.addEventListener('touchend', ask, { once: true })
      cleanup = () => window.removeEventListener('touchend', ask)
    }

    return () => cleanup()
  }, [containerRef])

  return tiltRef
}

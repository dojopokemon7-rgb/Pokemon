import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import { useAnimationFrame } from 'motion/react'
import { useMousePositionRef } from '../hooks/useMousePositionRef.js'
import { useDeviceTiltRef } from '../hooks/useDeviceTiltRef.js'

/*
 * Port of fancycomponents parallax-floating (danielpetho) to this codebase —
 * plain React + CSS instead of Tailwind/shadcn, identical mechanics:
 * a rAF loop eases registered elements toward mouse-offset targets, scaled
 * by each element's depth. Respects prefers-reduced-motion.
 *
 * On a phone there is no hovering pointer, so device tilt drives the same
 * targets instead — the cards drift toward the way the handset is leaning.
 */

const FloatingContext = createContext(null)

export default function Floating({ children, className = '', sensitivity = 1, easingFactor = 0.05, tilt = 8, ...props }) {
  const containerRef = useRef(null)
  const elementsMap = useRef(new Map())
  const mousePositionRef = useMousePositionRef(containerRef)
  const tiltRef = useDeviceTiltRef(containerRef)
  const reducedMotion = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const coarse = useRef(
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  )

  const registerElement = useCallback((id, element, depth) => {
    elementsMap.current.set(id, { element, depth, currentPosition: { x: 0, y: 0 } })
  }, [])

  const unregisterElement = useCallback((id) => {
    elementsMap.current.delete(id)
  }, [])

  useAnimationFrame(() => {
    if (!containerRef.current || reducedMotion.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const w = rect.width || 1
    const h = rect.height || 1

    // device tilt wins once the phone is actually reporting; otherwise the
    // pointer. On a handset that never reports — orientation denied, or a
    // browser that withholds it — the cards would sit dead still, so the
    // container's own travel up the viewport stands in as the input.
    let source = tiltRef.current.active ? tiltRef.current : mousePositionRef.current
    if (!tiltRef.current.active && coarse.current) {
      const seen = 1 - (rect.top + h / 2) / (window.innerHeight || 1)
      source = { x: w / 2, y: h * Math.max(0, Math.min(1, seen)) }
    }

    // -1 … 1 out from the container's centre, for the lean
    const nx = Math.max(-1, Math.min(1, (source.x / w) * 2 - 1))
    const ny = Math.max(-1, Math.min(1, (source.y / h) * 2 - 1))

    elementsMap.current.forEach((data) => {
      const strength = (data.depth * sensitivity) / 20

      const newTargetX = source.x * strength
      const newTargetY = source.y * strength

      const dx = newTargetX - data.currentPosition.x
      const dy = newTargetY - data.currentPosition.y

      data.currentPosition.x += dx * easingFactor
      data.currentPosition.y += dy * easingFactor

      // deeper cards lean further, the same way they drift further
      const lean = tilt * Math.min(data.depth, 2) * 0.5
      const ry = (nx * lean).toFixed(2)
      const rx = (-ny * lean).toFixed(2)

      data.element.style.transform =
        `perspective(700px) translate3d(${data.currentPosition.x}px, ${data.currentPosition.y}px, 0) rotateX(${rx}deg) rotateY(${ry}deg)`
    })
  })

  return (
    <FloatingContext.Provider value={{ registerElement, unregisterElement }}>
      <div
        ref={containerRef}
        className={`floating ${className}`}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        {...props}
      >
        {children}
      </div>
    </FloatingContext.Provider>
  )
}

export function FloatingElement({ children, className = '', depth = 1 }) {
  const elementRef = useRef(null)
  const idRef = useRef(Math.random().toString(36).substring(7))
  const context = useContext(FloatingContext)

  useEffect(() => {
    if (!elementRef.current || !context) return
    context.registerElement(idRef.current, elementRef.current, depth ?? 0.01)
    return () => context.unregisterElement(idRef.current)
  }, [depth]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={elementRef} className={className} style={{ position: 'absolute', willChange: 'transform' }}>
      {children}
    </div>
  )
}

import { useEffect, useRef } from 'react'

/*
 * Port of the beams-background component (shadcn/Tailwind original) to this
 * codebase — plain React + CSS, same canvas mechanics. Adapted for Dojo:
 * beams run in the brand's gold hue range instead of the demo's cyan/blue,
 * the canvas sizes to its container (not the window), and the loop draws a
 * single static frame under prefers-reduced-motion.
 */

const MINIMUM_BEAMS = 20

const OPACITY_MAP = { subtle: 0.7, medium: 0.85, strong: 1 }

function createBeam(width, height) {
  const angle = -35 + Math.random() * 10
  return {
    x: Math.random() * width * 1.5 - width * 0.25,
    y: Math.random() * height * 1.5 - height * 0.25,
    width: 30 + Math.random() * 60,
    length: height * 2.5,
    angle,
    speed: 0.6 + Math.random() * 1.2,
    opacity: 0.04 + Math.random() * 0.06,
    hue: 38 + Math.random() * 12, // dojo gold range
    pulse: Math.random() * Math.PI * 2,
    pulseSpeed: 0.02 + Math.random() * 0.03,
  }
}

export default function BeamsBackground({ className = '', intensity = 'subtle' }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const beamsRef = useRef([])
  const animationFrameRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let w = 0
    let h = 0

    const updateCanvasSize = () => {
      const rect = wrap.getBoundingClientRect()
      /* the wrapper is fixed inset:0 — if layout hasn't settled yet, fall
         back to the viewport so the canvas never mounts at 0×0 */
      const rw = rect.width || window.innerWidth
      const rh = rect.height || window.innerHeight
      const small = rw < 768
      /* phones ship dpr 2–3 — a full-res double-blurred canvas is a GPU tax
         for a backdrop nobody reads. cap resolution and thin the beams. */
      const dpr = Math.min(window.devicePixelRatio || 1, small ? 1 : 2)
      w = rw
      h = rh
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const totalBeams = small ? 12 : MINIMUM_BEAMS * 1.5
      beamsRef.current = Array.from({ length: totalBeams }, () => createBeam(w, h))
    }

    const resetBeam = (beam, index, totalBeams) => {
      const column = index % 3
      const spacing = w / 3

      beam.y = h + 100
      beam.x = column * spacing + spacing / 2 + (Math.random() - 0.5) * spacing * 0.5
      beam.width = 100 + Math.random() * 100
      beam.speed = 0.5 + Math.random() * 0.4
      beam.hue = 38 + (index * 12) / totalBeams
      beam.opacity = 0.06 + Math.random() * 0.05
      return beam
    }

    const drawBeam = (beam) => {
      ctx.save()
      ctx.translate(beam.x, beam.y)
      ctx.rotate((beam.angle * Math.PI) / 180)

      const pulsingOpacity = beam.opacity * (0.8 + Math.sin(beam.pulse) * 0.2) * OPACITY_MAP[intensity]

      /* dark gold — low lightness so beams read as warm shadow, not yellow light */
      const gradient = ctx.createLinearGradient(0, 0, 0, beam.length)
      gradient.addColorStop(0, `hsla(${beam.hue}, 55%, 38%, 0)`)
      gradient.addColorStop(0.1, `hsla(${beam.hue}, 55%, 38%, ${pulsingOpacity * 0.5})`)
      gradient.addColorStop(0.4, `hsla(${beam.hue}, 55%, 38%, ${pulsingOpacity})`)
      gradient.addColorStop(0.6, `hsla(${beam.hue}, 55%, 38%, ${pulsingOpacity})`)
      gradient.addColorStop(0.9, `hsla(${beam.hue}, 55%, 38%, ${pulsingOpacity * 0.5})`)
      gradient.addColorStop(1, `hsla(${beam.hue}, 55%, 38%, 0)`)

      ctx.fillStyle = gradient
      ctx.fillRect(-beam.width / 2, 0, beam.width, beam.length)
      ctx.restore()
    }

    const drawFrame = () => {
      ctx.clearRect(0, 0, w, h)
      ctx.filter = 'blur(35px)'
      const totalBeams = beamsRef.current.length
      beamsRef.current.forEach((beam, index) => {
        beam.y -= beam.speed
        beam.pulse += beam.pulseSpeed
        if (beam.y + beam.length < -100) resetBeam(beam, index, totalBeams)
        drawBeam(beam)
      })
    }

    const animate = () => {
      drawFrame()
      animationFrameRef.current = requestAnimationFrame(animate)
    }

    updateCanvasSize()
    /* ResizeObserver + window.resize — belt and suspenders for viewport and
       orientation changes; redraws the still frame under reduced motion so
       the backdrop never renders at a stale size. */
    const onResize = () => {
      const rect = wrap.getBoundingClientRect()
      if (Math.abs((rect.width || window.innerWidth) - w) < 1 && Math.abs((rect.height || window.innerHeight) - h) < 1) return
      updateCanvasSize()
      if (reducedMotion) drawFrame()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(wrap)
    window.addEventListener('resize', onResize)

    /* a backdrop loop has no business burning a phone's battery behind a
       backgrounded tab — park it until the page is visible again */
    const onVisibility = () => {
      if (reducedMotion) return
      if (document.hidden) {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = 0
      } else if (!animationFrameRef.current) {
        animate()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    if (reducedMotion) {
      drawFrame() // one still frame, no loop
    } else {
      animate()
    }

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    }
  }, [intensity])

  return (
    <div ref={wrapRef} className={`beams-bg ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}

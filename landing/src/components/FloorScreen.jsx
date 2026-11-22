import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import zoroImg from '../assets/floor/zoro.jpg'
import charizardImg from '../assets/floor/charizard.webp'
import gengarImg from '../assets/floor/gengar.webp'
import luffyImg from '../assets/floor/luffy.webp'

/*
 * The Floor — WTB / WTS. Implemented from "The Floor.dc.html" in the
 * claude.ai/design project "iPhone screen mockup" (648a5228…).
 * Interactive: filter tabs, listing actions, tab bar — all flash toasts.
 */

const LISTINGS = [
  { side: 'WTS', img: zoroImg, name: 'Roronoa Zoro', meta: 'OP12 · 020 · SEC · PSA 10 GEM MT', price: '₹1,45,000', poster: 'Grand Line Cards', verified: true, time: '1h' },
  { side: 'WTS', img: charizardImg, name: 'Charizard ex', meta: 'SV 151 · 199/165 · SIR · PSA 10', price: '₹98,000', poster: 'Slabs and Foils', verified: true, time: '2h' },
  { side: 'WTB', img: gengarImg, name: 'Mega Gengar ex', meta: 'Ascended · 284/217 · SIR · NM+', price: '₹34,000', poster: '@kaiju.slabs', verified: false, time: '4h' },
  { side: 'WTS', img: luffyImg, name: 'Monkey D. Luffy', meta: 'OP05 · 119 · SEC · near mint', price: '₹63,000', poster: 'Grand Line Cards', verified: true, time: '5h' },
]

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'wtb', label: 'WTB' },
  { id: 'wts', label: 'WTS' },
]

const TABS_LEFT = [
  { id: 'home', icon: 'house', label: 'Home' },
  { id: 'shop', icon: 'package', label: 'Shop' },
]
const TABS_RIGHT = [
  { id: 'explore', icon: 'search', label: 'Explore' },
  { id: 'you', icon: 'user', label: 'You' },
]

const TOAST_BG = { success: 'var(--jade-500)', warning: 'var(--amber-500)', error: 'var(--verm-500)' }

const capsStyle = (size, tracking = '0.14em') => ({
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontStretch: '112%',
  fontSize: size,
  letterSpacing: tracking,
  textTransform: 'uppercase',
})

function PointerArrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M0 6h10M7 3l3 3-3 3" strokeLinecap="square" />
    </svg>
  )
}

export default function FloorScreen() {
  const [tab, setTab] = useState('explore')
  const [filter, setFilter] = useState('all')
  const [toast, setToast] = useState(null)
  const toastTimer = useRef()

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flashToast = (type, heading, description) => {
    clearTimeout(toastTimer.current)
    setToast({ type, heading, description })
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  const listings = filter === 'all' ? LISTINGS : LISTINGS.filter((x) => x.side.toLowerCase() === filter)

  const pickTab = (id) => {
    setTab(id)
    if (id !== 'explore') flashToast('warning', 'Prototype', 'Only the trading floor is built in this mockup.')
  }

  const tabButton = (t) => (
    <button
      key={t.id}
      type="button"
      onClick={() => pickTab(t.id)}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        padding: '12px 0 10px', cursor: 'pointer', background: 'none', border: 'none',
        color: tab === t.id ? 'var(--text-heading)' : 'var(--text-faint)',
        borderTop: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`, marginTop: -1,
      }}
    >
      <Icon name={t.icon} size={19} strokeWidth={1.75} />
      <span style={capsStyle('7.5px', '0.18em')}>{t.label}</span>
    </button>
  )

  return (
    <div
      data-screen-label="The Floor — WTB / WTS"
      style={{
        width: 390, height: 844, display: 'flex', flexDirection: 'column', position: 'relative',
        overflow: 'hidden', border: '1px solid var(--stroke-card)', background: 'var(--surface-app)',
        fontFamily: 'var(--font-body)', textAlign: 'left',
      }}
    >
      {toast && (
        <div
          role="status"
          style={{
            position: 'absolute', top: 54, left: 12, right: 12, zIndex: 1100, display: 'flex',
            alignItems: 'flex-start', gap: 12, borderRadius: 4, padding: '14px 15px',
            color: '#F8F8F8', background: TOAST_BG[toast.type],
          }}
        >
          <div>
            <div style={{ ...capsStyle('9px'), lineHeight: 1.3 }}>{toast.heading}</div>
            <div style={{ fontSize: '11.5px', lineHeight: 1.4, opacity: 0.92, marginTop: 3 }}>{toast.description}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 30px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>9:41</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 8, letterSpacing: '0.14em', color: 'var(--text-body)' }}>◆ ◆ ◆</div>
      </div>

      {/* back arrow where the eyebrow used to sit, matching the other screens */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px 0', flex: 'none' }}>
        <button
          type="button"
          onClick={() => flashToast('warning', 'Back', 'This is the top of the mockup.')}
          aria-label="back"
          style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text-subheading)', background: 'none', border: 'none', padding: 0 }}
        >
          <svg width="22" height="10" viewBox="0 0 24 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M24 5H2M6 1 2 5l4 4" strokeLinecap="square" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => flashToast('success', 'Messages', 'Your floor conversations live here.')}
          aria-label="messages"
          style={{
            width: 38, height: 38, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid var(--stroke-card)', background: 'var(--surface-card)', color: 'var(--text-subheading)', cursor: 'pointer',
          }}
        >
          <Icon name="message-circle" size={19} strokeWidth={1.75} />
        </button>
      </div>

      <div style={{ padding: '11px 24px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 32, lineHeight: 1, color: 'var(--text-heading)' }}>Trading floor</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px 4px', flex: 'none' }}>
        <div style={{ display: 'flex', flex: 1, border: '1px solid var(--stroke-card)', background: 'var(--surface-card)' }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              style={{
                flex: 1, textAlign: 'center', padding: '9px 0', cursor: 'pointer', border: 'none',
                borderRight: '1px solid var(--divider)',
                ...capsStyle('9.5px'), fontWeight: 800,
                background: filter === f.id ? 'var(--accent)' : 'transparent',
                color: filter === f.id ? '#0D0D0D' : 'var(--text-subheading)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, background: 'var(--positive)', flex: 'none' }} />
          <span style={{ ...capsStyle('8px', '0.12em'), color: 'var(--text-faint)' }}>128 open</span>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', padding: '8px 24px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {listings.map((it) => (
          <div key={it.name} style={{ background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', boxShadow: 'var(--plunk-w) var(--plunk-w) 0 0 var(--edge-bottom)', padding: '11px 14px 10px' }}>
            <div style={{ display: 'flex', gap: 13 }}>
              <div style={{ width: 56, flex: 'none', aspectRatio: '5/7', background: '#000', border: '1px solid var(--stroke-card)', overflow: 'hidden', boxSizing: 'border-box' }}>
                <img src={it.img} alt={it.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', transform: 'scale(1.04)', display: 'block' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span
                    style={{
                      flex: 'none', padding: '3px 7px', ...capsStyle('8.5px', '0.12em'), fontWeight: 800,
                      ...(it.side === 'WTS'
                        ? { background: 'var(--positive)', color: '#0D0D0D', border: 'none' }
                        : { background: 'transparent', color: 'var(--text-subheading)', border: '1px solid var(--stroke-strong)' }),
                    }}
                  >
                    {it.side}
                  </span>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div style={{ ...capsStyle('7px'), color: 'var(--text-faint)' }}>{it.side === 'WTS' ? 'Ask' : 'Max budget'}</div>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontVariantNumeric: 'tabular-nums', fontSize: 19, lineHeight: 1, color: 'var(--text-heading)', marginTop: 2 }}>{it.price}</div>
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontSize: 16, lineHeight: 1.05, color: 'var(--text-heading)', marginTop: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
                <div style={{ ...capsStyle('8px', '0.1em'), color: 'var(--text-body)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.meta}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--divider)' }}>
              {it.verified && (
                <span style={{ display: 'flex', alignItems: 'center', color: 'var(--accent)' }}>
                  <Icon name="shield-check" size={12} strokeWidth={2} />
                </span>
              )}
              <span style={{ ...capsStyle('8.5px', '0.1em'), color: it.verified ? 'var(--text-heading)' : 'var(--text-subheading)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.poster}</span>
              <span style={{ ...capsStyle('8px', '0.1em'), color: 'var(--text-faint)', flex: 'none' }}>· {it.time}</span>
              <button
                type="button"
                onClick={() =>
                  flashToast(
                    'success',
                    it.side === 'WTS' ? 'Offer sent' : 'Reply sent',
                    it.side === 'WTS'
                      ? `Your offer on ${it.name} was sent to ${it.poster}.`
                      : `You told ${it.poster} you have a ${it.name}.`
                  )
                }
                style={{
                  marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 11px', border: '1px solid var(--edge-accent-right)', background: 'none',
                  color: 'var(--accent)', cursor: 'pointer',
                }}
              >
                <span style={{ ...capsStyle('8.5px', '0.1em'), fontWeight: 800 }}>{it.side === 'WTS' ? 'Offer' : 'I have one'}</span>
                <PointerArrow />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', borderTop: '1px solid var(--divider)', background: 'var(--surface-card)', flex: 'none' }}>
        {TABS_LEFT.map(tabButton)}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0' }}>
          <button
            type="button"
            onClick={() => flashToast('success', 'Scan', 'Point your camera at a card to add it.')}
            aria-label="scan a card"
            style={{
              width: 44, height: 44, background: 'var(--accent)', border: 'none',
              boxShadow: 'var(--plunk-w) var(--plunk-w) 0 0 var(--edge-accent-bottom)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0D0D0D', cursor: 'pointer',
            }}
          >
            <Icon name="scan-line" size={20} />
          </button>
        </div>
        {TABS_RIGHT.map(tabButton)}
      </div>
    </div>
  )
}

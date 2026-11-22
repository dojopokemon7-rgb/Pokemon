import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

/*
 * Events Near You. Implemented from "Events Near You.dc.html" in the
 * claude.ai/design project "iPhone screen mockup" (648a5228…).
 * The design's iPhone device chrome (rounded bezel, dynamic island) is
 * omitted so the embed matches the other square-framed screens.
 * Interactive: city filter chips, RSVP rows, follow star, tab bar.
 */

const ALL_EVENTS = [
  { day: '26', month: 'JUL', title: 'Andheri league night', city: 'MUMBAI', fmt: 'CASUAL + RANKED', going: 32 },
  { day: '02', month: 'AUG', title: 'Regional qualifier', city: 'BENGALURU', fmt: 'SWISS · CAP 128', going: 96 },
  { day: '09', month: 'AUG', title: 'Sealed launch party', city: 'DELHI', fmt: 'PRISMATIC EVOLUTIONS', going: 48 },
  { day: '16', month: 'AUG', title: 'Trade night at the dojo', city: 'MUMBAI', fmt: 'BRING YOUR BINDER', going: 57 },
  { day: '23', month: 'AUG', title: 'Powai draft cup', city: 'MUMBAI', fmt: 'DRAFT · CAP 32', going: 24 },
  { day: '30', month: 'AUG', title: 'Indiranagar collectors meet', city: 'BENGALURU', fmt: 'CASUAL', going: 41 },
]

const FILTERS = ['ALL', 'MUMBAI', 'BENGALURU', 'DELHI']

const AV = ['#0AC27E', '#EF4423', '#4A78E0', '#E9B43B', '#B267E6']

const TABS_LEFT = [
  { id: 'home', icon: 'house', label: 'Home' },
  { id: 'shop', icon: 'package', label: 'Shop' },
]
const TABS_RIGHT = [
  { id: 'explore', icon: 'search', label: 'Explore' },
  { id: 'you', icon: 'user', label: 'You' },
]

const TOAST_BG = { success: 'var(--positive)', warning: 'var(--warning)', error: 'var(--negative)' }

const caps = (size, tracking = '0.14em') => ({
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontStretch: '112%',
  fontSize: size,
  letterSpacing: tracking,
  textTransform: 'uppercase',
})

function Avatars({ seed }) {
  const shown = 3
  return (
    <div style={{ display: 'flex' }} aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <div
          key={i}
          style={{
            width: 17, height: 17, flex: 'none',
            background: AV[(i + seed) % AV.length],
            border: '1.5px solid var(--surface-app)',
            marginLeft: i === 0 ? 0 : -6,
            zIndex: shown - i,
            position: 'relative',
          }}
        />
      ))}
    </div>
  )
}

export default function EventsScreen() {
  const [filter, setFilter] = useState('ALL')
  const [tab, setTab] = useState('explore')
  const [saved, setSaved] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef()

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flashToast = (type, heading, description) => {
    clearTimeout(toastTimer.current)
    setToast({ type, heading, description })
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  const events = ALL_EVENTS.filter((e) => filter === 'ALL' || e.city === filter)

  const pickTab = (id) => {
    setTab(id)
    if (id !== 'explore') flashToast('warning', 'Prototype', 'Only Explore is built in this mockup.')
  }

  const toggleSaved = () => {
    const next = !saved
    setSaved(next)
    flashToast('success', next ? 'Following' : 'Unfollowed', next ? 'Events near you added to your calendar.' : 'Removed from your calendar.')
  }

  const tabButton = (t) => (
    <button
      key={t.id}
      type="button"
      onClick={() => pickTab(t.id)}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        padding: '11px 0 6px', cursor: 'pointer', background: 'none', border: 'none',
        color: tab === t.id ? 'var(--text-heading)' : 'var(--text-faint)',
        borderTop: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`, marginTop: -1,
      }}
    >
      <Icon name={t.icon} size={19} strokeWidth={1.75} />
      <span style={caps('7px', '0.16em')}>{t.label}</span>
    </button>
  )

  return (
    <div
      data-screen-label="Events Near You"
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
            position: 'absolute', top: 58, left: 14, right: 14, zIndex: 1100, display: 'flex',
            alignItems: 'center', gap: 11, borderRadius: 4, padding: '14px 15px',
            color: '#F8F8F8', background: TOAST_BG[toast.type],
          }}
        >
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13 }}>◆</span>
          <div>
            <div style={{ ...caps('8.5px'), opacity: 0.85 }}>{toast.heading}</div>
            <div style={{ fontWeight: 500, fontSize: 12, lineHeight: 1.35, marginTop: 2 }}>{toast.description}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 32px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--text-heading)', letterSpacing: '0.02em' }}>9:41</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 8, letterSpacing: '0.16em', color: 'var(--text-subheading)' }}>◆ ◆ ◆</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '26px 26px 0', flex: 'none' }}>
        <div>
          <div style={{ ...caps('9px', '0.22em'), fontWeight: 800, color: 'var(--accent)' }}>Explore</div>
          <div style={{ marginTop: 7, fontFamily: 'var(--font-serif)', fontWeight: 400, fontSize: 34, lineHeight: 0.95, color: 'var(--text-heading)' }}>Events near you</div>
        </div>
        <button
          type="button"
          onClick={toggleSaved}
          aria-label={saved ? 'unfollow events near you' : 'follow events near you'}
          aria-pressed={saved}
          style={{
            width: 38, height: 38, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', background: 'none', border: 'none',
            color: saved ? 'var(--accent)' : 'var(--text-subheading)',
          }}
        >
          <Icon name="star" size={21} strokeWidth={1.6} />
        </button>
      </div>

      <div style={{ padding: '14px 26px 0', flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 5, height: 5, background: 'var(--accent)', flex: 'none' }} />
        <div style={{ ...caps('8.5px'), color: 'var(--text-body)' }}>Mumbai · Bengaluru · Delhi</div>
        <div style={{ marginLeft: 'auto', ...caps('8.5px'), color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{events.length} this month</div>
      </div>

      <div className="evt-scroll" style={{ display: 'flex', gap: 9, padding: '16px 26px 4px', flex: 'none', overflowX: 'auto' }}>
        {FILTERS.map((label) => {
          const active = filter === label
          return (
            <button
              key={label}
              type="button"
              onClick={() => setFilter(label)}
              aria-pressed={active}
              style={{
                flex: 'none', padding: '9px 15px', cursor: 'pointer',
                ...caps('9px', '0.16em'), fontWeight: 800,
                background: active ? 'var(--accent)' : 'var(--surface-card)',
                color: active ? 'var(--text-on-accent)' : 'var(--text-subheading)',
                border: active ? '1px solid var(--accent)' : '1px solid var(--stroke-card)',
                boxShadow: active ? '2px 2px 0 0 var(--edge-accent-bottom)' : 'none',
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="evt-scroll" style={{ flex: 1, overflowY: 'auto', padding: '8px 26px 20px' }}>
        {events.map((e, i) => (
          <div
            key={e.title}
            onClick={() => flashToast('success', 'RSVP confirmed', `you're going to ${e.title.toLowerCase()}.`)}
            style={{
              display: 'flex', alignItems: 'stretch', gap: 15, padding: '16px 0',
              borderTop: `1px solid ${i === 0 ? 'transparent' : 'var(--divider)'}`, cursor: 'pointer',
            }}
          >
            <div style={{ width: 52, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '9px 0', background: 'var(--surface-card)', border: '1px solid var(--stroke-card)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontVariantNumeric: 'tabular-nums', fontSize: 23, lineHeight: 1, color: 'var(--text-heading)' }}>{e.day}</div>
              <div style={{ marginTop: 3, ...caps('8px', '0.16em'), fontWeight: 800, color: 'var(--text-faint)' }}>{e.month}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16.5, lineHeight: 1.1, color: 'var(--text-heading)', letterSpacing: '-0.01em' }}>{e.title}</div>
              <div style={{ marginTop: 6, ...caps('8.5px', '0.13em'), color: 'var(--text-body)' }}>{e.city} · {e.fmt}</div>
              <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 9 }}>
                <Avatars seed={e.going} />
                <span style={{ ...caps('8.5px', '0.1em'), fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: 'var(--accent)' }}>{e.going} GOING</span>
              </div>
            </div>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}>
              <svg width="9" height="14" viewBox="0 0 9 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M1.5 1 7.5 7l-6 6" strokeLinecap="square" />
              </svg>
            </div>
          </div>
        ))}
        <div style={{ height: 1, background: 'var(--divider)' }} />
        <div style={{ textAlign: 'center', padding: '22px 0 4px', ...caps('8px', '0.2em'), color: 'var(--text-faint)' }}>· end of this month ·</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', borderTop: '1px solid var(--divider)', background: 'var(--surface-card)', flex: 'none' }}>
        {TABS_LEFT.map(tabButton)}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 0' }}>
          <button
            type="button"
            onClick={() => flashToast('warning', 'Scan', 'Scanner lives on the home tab.')}
            aria-label="scan a card"
            style={{
              width: 44, height: 44, background: 'var(--accent)', border: 'none',
              boxShadow: '3px 3px 0 0 var(--edge-accent-bottom)',
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

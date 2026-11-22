import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import logoImg from '../assets/floor/slabs-foils-logo.png'
import charizardImg from '../assets/floor/charizard.webp'
import gengarImg from '../assets/floor/gengar.webp'
import luffyImg from '../assets/floor/luffy.webp'

/*
 * Slabs and Foils — Dojo Verified Store. Implemented from
 * "Slabs and Foils - Dojo Verified Store.html" in the claude.ai/design
 * project "iPhone screen mockup" (648a5228…).
 * Interactive: ask stepper, SET ASK, favorite, store band, product cards, tabs.
 */

const SALES = [
  { date: '12 Jul', channel: 'Auction', price: '₹98,000', up: true },
  { date: '09 Jul', channel: 'Direct sale', price: '₹96,500', up: false },
  { date: '05 Jul', channel: 'Auction', price: '₹1,01,200', up: true },
  { date: '28 Jun', channel: 'Direct sale', price: '₹88,000', up: false },
  { date: '21 Jun', channel: 'Direct sale', price: '₹91,500', up: true },
]

const OTHERS = [
  { img: gengarImg, name: 'Mega Gengar ex', price: '₹35,000' },
  { img: luffyImg, name: 'Monkey D. Luffy', price: '₹63,000' },
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

const money = (n) => '₹' + n.toLocaleString('en-IN')

const caps = (size, tracking = '0.14em') => ({
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontStretch: '112%',
  fontSize: size,
  letterSpacing: tracking,
  textTransform: 'uppercase',
})

const num = (size) => ({
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontStretch: '87%',
  fontVariantNumeric: 'tabular-nums',
  fontSize: size,
})

export default function StoreScreen() {
  const [tab, setTab] = useState('shop')
  const [ask, setAsk] = useState(103000)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef()

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flashToast = (type, heading, description) => {
    clearTimeout(toastTimer.current)
    setToast({ type, heading, description })
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  const pickTab = (id) => {
    setTab(id)
    if (id !== 'shop') flashToast('warning', 'Prototype', 'Only Shop is built in this mockup.')
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
      <span style={caps('7.5px', '0.18em')}>{t.label}</span>
    </button>
  )

  return (
    <div
      data-screen-label="Verified Store Listing — Charizard ex"
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
            position: 'absolute', top: 54, left: 10, right: 10, zIndex: 1100, display: 'flex',
            alignItems: 'flex-start', gap: 12, borderRadius: 4, padding: 15,
            color: '#F8F8F8', background: TOAST_BG[toast.type],
          }}
        >
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>{toast.heading}</div>
            <div style={{ fontSize: 11, lineHeight: 1.4, opacity: 0.9, marginTop: 2 }}>{toast.description}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 30px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>9:41</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 8, letterSpacing: '0.14em', color: 'var(--text-body)' }}>◆ ◆ ◆</div>
      </div>

      {/* same header shape as Price triggers — the back arrow rides its own row
          above the title, with the screen's action opposite it */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px 0', flex: 'none' }}>
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
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => flashToast('success', 'Saved', 'Charizard ex added to your watchlist.')}
          aria-label="save to watchlist"
          style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text-subheading)', background: 'none', border: 'none', padding: 0 }}
        >
          <Icon name="heart" size={20} strokeWidth={1.75} />
        </button>
      </div>

      <div style={{ padding: '11px 24px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontWeight: 400, fontSize: 32, lineHeight: 1, color: 'var(--text-heading)' }}>Trusted stores</div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', padding: '10px 24px 0', display: 'flex', flexDirection: 'column' }}>
        <div
          onClick={() => flashToast('success', 'Slabs and Foils', 'Dojo Verified store — opening storefront.')}
          style={{
            display: 'flex', alignItems: 'center', gap: 13, background: 'var(--surface-card)',
            border: '1px solid var(--stroke-card)', borderLeft: '3px solid var(--accent)',
            padding: '11px 14px', cursor: 'pointer',
          }}
        >
          <div style={{ width: 40, height: 40, flex: 'none', overflow: 'hidden' }}>
            <img src={logoImg} alt="Slabs and Foils" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontSize: 15, lineHeight: 1.05, color: 'var(--text-heading)' }}>Slabs and Foils</div>
            <div style={{ marginTop: 3, ...caps('8px', '0.12em'), color: 'var(--text-faint)' }}>
              Mumbai · <span style={{ letterSpacing: '0.96px' }}>★ 4.9</span>
              <br />2,410 sales
            </div>
          </div>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 5, padding: '6px 9px', border: '1px solid var(--edge-accent-right)', color: 'var(--accent)', whiteSpace: 'nowrap' }}>
            <Icon name="shield-check" size={13} strokeWidth={2} />
            <span style={{ ...caps('8.5px', '0.1em'), fontWeight: 800 }}>Dojo Verified</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
          <div style={{ width: 100, flex: 'none', aspectRatio: '5/7', background: '#000', border: '1px solid var(--stroke-card)', overflow: 'hidden', boxSizing: 'border-box', boxShadow: 'var(--plunk-w) var(--plunk-w) 0 0 var(--edge-bottom)' }}>
            <img src={charizardImg} alt="Charizard ex" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', transform: 'scale(1.05)', display: 'block' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontSize: 21, lineHeight: 1.05, color: 'var(--text-heading)' }}>Charizard ex</div>
            <div style={{ marginTop: 5, ...caps('9px', '0.12em'), color: 'var(--text-body)' }}>SV · 151 · 199/165 · SIR</div>
            <div style={{ marginTop: 16 }}>
              <div style={{ ...caps('8px'), color: 'var(--text-faint)' }}>Last sale</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 3 }}>
                <div style={{ ...num(22), color: 'var(--text-heading)' }}>₹98,000</div>
                <div style={{ ...caps('9px', '0.1em'), color: 'var(--positive)' }}>▲ 6.3%</div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 14, marginTop: 12 }}>
          <div style={{ flex: 1, background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', padding: '12px 14px' }}>
            <div style={{ ...caps('8px'), color: 'var(--text-faint)' }}>Highest bid</div>
            <div style={{ marginTop: 5, ...num(22), color: 'var(--positive)' }}>₹90,500</div>
          </div>
          <div style={{ flex: 1, background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', padding: '12px 14px' }}>
            <div style={{ ...caps('8px'), color: 'var(--text-faint)' }}>Lowest ask</div>
            <div style={{ marginTop: 5, ...num(22), color: 'var(--accent)' }}>₹1,03,000</div>
          </div>
        </div>

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'stretch', gap: 12 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', border: '1px solid var(--stroke-card)', background: 'var(--surface-card)' }}>
            <button
              type="button"
              onClick={() => setAsk((a) => Math.max(500, a - 500))}
              aria-label="lower your ask"
              style={{ width: 44, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-subheading)', borderRight: '1px solid var(--divider)', background: 'none', border: 'none', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20 }}
            >
              −
            </button>
            <div style={{ flex: 1, textAlign: 'center', padding: '8px 0' }}>
              <div style={{ ...caps('7.5px'), color: 'var(--text-faint)' }}>Your ask</div>
              <div style={{ marginTop: 1, ...num(19), color: 'var(--text-heading)' }}>{money(ask)}</div>
            </div>
            <button
              type="button"
              onClick={() => setAsk((a) => a + 500)}
              aria-label="raise your ask"
              style={{ width: 44, alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-subheading)', borderLeft: '1px solid var(--divider)', background: 'none', border: 'none', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 20 }}
            >
              +
            </button>
          </div>
          <button
            type="button"
            onClick={() => flashToast('success', 'Ask placed', `Your ask of ${money(ask)} is live on Charizard ex.`)}
            style={{
              width: 118, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent)', color: 'var(--text-on-accent)', border: 'none', cursor: 'pointer',
              boxShadow: 'var(--plunk-w) var(--plunk-w) 0 0 var(--edge-accent-bottom)',
              ...caps('11px'), fontWeight: 800,
            }}
          >
            Set ask
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ ...caps('10px', '0.16em'), fontWeight: 800, color: 'var(--text-subheading)' }}>Recent sales</div>
            <div style={{ marginLeft: 'auto', ...caps('8px'), color: 'var(--text-faint)' }}>Last 5 sales</div>
          </div>
          <div style={{ background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', padding: '2px 24px', margin: '0 -24px' }}>
            {SALES.map((s, i) => (
              <div key={s.date} style={{ display: 'flex', alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${i === 0 ? 'transparent' : 'var(--divider)'}` }}>
                <div style={{ ...caps('10px', '0.1em'), color: 'var(--text-body)' }}>{s.date}</div>
                <div style={{ marginLeft: 14, fontSize: 11, color: 'var(--text-faint)' }}>{s.channel}</div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ ...caps('9px', '0.08em'), color: s.up ? 'var(--positive)' : 'var(--negative)' }}>{s.up ? '▲' : '▼'}</span>
                  <span style={{ ...num(14), color: 'var(--text-heading)' }}>{s.price}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 'auto', paddingBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ ...caps('10px', '0.16em'), fontWeight: 800, color: 'var(--text-subheading)' }}>Other products from the store</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {OTHERS.map((p) => (
              <div
                key={p.name}
                onClick={() => flashToast('success', p.name, 'Opening listing from Slabs and Foils.')}
                style={{ display: 'flex', alignItems: 'center', gap: 11, background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', padding: 9, cursor: 'pointer' }}
              >
                <div style={{ width: 38, flex: 'none', aspectRatio: '5/7', background: '#000', border: '1px solid var(--stroke-card)', padding: 3, boxSizing: 'border-box' }}>
                  <img src={p.img} alt={p.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, lineHeight: 1.15, color: 'var(--text-heading)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                  <div style={{ marginTop: 4, ...num(14), color: 'var(--text-heading)' }}>{p.price}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
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

import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import charizardImg from '../assets/floor/charizard.webp'
import gengarImg from '../assets/floor/gengar.webp'
import zoroImg from '../assets/floor/zoro.jpg'
import luffyImg from '../assets/floor/luffy.webp'

/*
 * Price Triggers. Implemented from "Price Triggers.dc.html" in the
 * claude.ai/design project "iPhone screen mockup" (648a5228…).
 * The design's iOS device chrome is omitted; a status bar is added so the
 * embed matches the other square-framed screens.
 */

const money = (n) => '₹' + n.toLocaleString('en-IN')

// buy = you want it, waiting for a drop (gold) · sell = you hold it, waiting for a rise (jade)
const DATA = [
  { img: gengarImg, name: 'Mega Gengar ex', kind: 'buy', meta: 'RAW · NM', target: 32000, now: 35000 },
  { img: zoroImg, name: 'Roronoa Zoro', kind: 'sell', meta: 'PSA 10 · SERIALISED', target: 178000, now: 164500 },
  { img: luffyImg, name: 'Monkey D. Luffy', kind: 'buy', meta: 'SEC · ALT ART', target: 58000, now: 63000 },
]

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

const TABS_LEFT = [
  { id: 'home', icon: 'house', label: 'Home' },
  { id: 'shop', icon: 'package', label: 'Shop' },
]
const TABS_RIGHT = [
  { id: 'explore', icon: 'search', label: 'Explore' },
  { id: 'you', icon: 'user', label: 'You' },
]

export default function TriggersScreen() {
  const [tab, setTab] = useState('you')
  const [toast, setToast] = useState(null)
  const toastTimer = useRef()

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const flashToast = (heading, description) => {
    clearTimeout(toastTimer.current)
    setToast({ heading, description })
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  const pickTab = (id) => {
    setTab(id)
    if (id !== 'you') flashToast('Prototype', 'Only price triggers are built in this mockup.')
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
      <span style={caps('7.5px', '0.16em')}>{t.label}</span>
    </button>
  )

  return (
    <div
      data-screen-label="Price Triggers"
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
            position: 'absolute', top: 54, left: 14, right: 14, zIndex: 1100, display: 'flex',
            alignItems: 'center', gap: 11, borderRadius: 4, padding: '14px 15px',
            color: '#F8F8F8', background: 'var(--warning)',
          }}
        >
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13 }}>◆</span>
          <div>
            <div style={{ ...caps('8.5px'), opacity: 0.85 }}>{toast.heading}</div>
            <div style={{ fontWeight: 500, fontSize: 12, lineHeight: 1.35, marginTop: 2 }}>{toast.description}</div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 22px 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 8px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>9:41</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 8, letterSpacing: '0.14em', color: 'var(--text-body)' }}>◆ ◆ ◆</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none', marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-subheading)' }}>
          <svg width="22" height="10" viewBox="0 0 24 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M24 5H2M6 1 2 5l4 4" strokeLinecap="square" />
          </svg>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', color: 'var(--text-subheading)' }}>
          <Icon name="bell" size={21} strokeWidth={1.75} />
          <span style={{ position: 'absolute', top: -2, right: -2, width: 8, height: 8, background: 'var(--accent)' }} />
        </div>
      </div>

      <div style={{ marginTop: 11, flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontWeight: 400, fontSize: 31, lineHeight: 1, color: 'var(--text-heading)' }}>Price triggers</div>
        <div style={{ marginTop: 11, ...caps('9px', '0.16em'), color: 'var(--text-faint)' }}>
          3 armed<span style={{ opacity: 0.5 }}>&nbsp;&nbsp;·&nbsp;&nbsp;</span>1 hit today
        </div>
      </div>

      {/* triggered hero */}
      <div style={{ marginTop: 10, flex: 'none', background: 'var(--accent)', padding: '13px 17px 14px', boxShadow: '6px 6px 0 0 var(--edge-accent-bottom)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ display: 'inline-flex', color: '#0D0D0D' }}>
              <Icon name="bell" size={13} strokeWidth={2.25} />
            </span>
            <span style={{ ...caps('9.5px', '0.18em'), fontWeight: 800, color: '#0D0D0D' }}>Target hit</span>
          </div>
          <span style={{ ...caps('8.5px'), color: 'rgba(13,13,13,0.55)' }}>2h ago</span>
        </div>

        <div style={{ display: 'flex', gap: 14, marginTop: 14 }}>
          <div style={{ width: 60, flex: 'none', aspectRatio: '5/7', background: '#0D0D0D', overflow: 'hidden', boxShadow: '3px 3px 0 0 rgba(13,13,13,0.28)' }}>
            <img src={charizardImg} alt="Charizard ex" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', transform: 'scale(1.04)', display: 'block' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontSize: 20, lineHeight: 1, color: '#0D0D0D' }}>Charizard ex</div>
            <div style={{ marginTop: 6, ...caps('8.5px', '0.13em'), color: 'rgba(13,13,13,0.6)' }}>SV · 151 · 199/165 · SIR</div>
            <div style={{ marginTop: 9, ...caps('8.5px', '0.1em'), fontWeight: 800, color: '#0D0D0D', display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', border: '1.5px solid rgba(13,13,13,0.35)', padding: '3px 7px' }}>
              Buy · when it drops
            </div>
          </div>
        </div>

        <div style={{ height: 1.5, background: 'rgba(13,13,13,0.18)', margin: '13px 0 12px' }} />

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div style={{ ...caps('8px'), color: 'rgba(13,13,13,0.55)' }}>Your target</div>
            <div style={{ marginTop: 4, ...num(19), color: 'rgba(13,13,13,0.75)' }}>₹95,000</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ ...caps('8px'), color: 'rgba(13,13,13,0.55)' }}>Dropped to</div>
            <div style={{ marginTop: 2, display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{ ...caps('12px', '0'), color: '#0D0D0D' }}>▼</span>
              <span style={{ ...num(28), lineHeight: 0.9, color: '#0D0D0D' }}>₹94,200</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 11, marginBottom: 8, flex: 'none' }}>
        <div style={{ ...caps('10px', '0.18em'), fontWeight: 800, color: 'var(--text-subheading)' }}>Armed</div>
        <div style={{ marginLeft: 'auto', ...caps('8.5px'), color: 'var(--text-faint)' }}>Watching live</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 'none' }}>
        {DATA.map((d) => {
          const want = d.kind === 'buy'
          const prox = want ? d.target / d.now : d.now / d.target
          const pct = Math.max(6, Math.min(98, Math.round(prox * 100)))
          const diff = Math.abs(d.now - d.target)
          const tagColor = want ? 'var(--accent)' : 'var(--positive)'
          return (
            <div key={d.name} style={{ background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', padding: '11px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <div style={{ width: 44, flex: 'none', aspectRatio: '5/7', background: '#000', border: '1px solid var(--stroke-card)', overflow: 'hidden' }}>
                  <img src={d.img} alt={d.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', display: 'block' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontSize: 15, lineHeight: 1.05, color: 'var(--text-heading)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...caps('8px', '0.12em'), fontWeight: 800, padding: '3px 6px', border: `1px solid ${tagColor}`, color: tagColor }}>{want ? 'Buy' : 'Sell'}</span>
                    <span style={{ ...caps('8px', '0.12em'), color: 'var(--text-faint)' }}>{d.meta}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ ...caps('7.5px'), color: 'var(--text-faint)' }}>Target</div>
                  <div style={{ marginTop: 3, ...num(17), color: tagColor }}>{money(d.target)}</div>
                </div>
              </div>

              <div style={{ marginTop: 11 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 7 }}>
                  <span style={{ ...caps('8px'), color: 'var(--text-body)' }}>
                    Now&nbsp;&nbsp;<span style={{ fontWeight: 800, fontStretch: '87%', letterSpacing: 0, fontSize: 12, color: 'var(--text-heading)', fontVariantNumeric: 'tabular-nums' }}>{money(d.now)}</span>
                  </span>
                  <span style={{ ...caps('8px', '0.1em'), fontWeight: 800, color: want ? 'var(--negative)' : 'var(--positive)', fontVariantNumeric: 'tabular-nums' }}>
                    {want ? '▼' : '▲'} {money(diff)} to target
                  </span>
                </div>
                <div style={{ height: 4, background: 'var(--surface-raised)', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: `${pct}%`, background: tagColor }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 10, flex: 'none' }}>
        <button
          type="button"
          className="triggers-cta"
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            background: 'var(--accent)', border: 'none', padding: 15, cursor: 'pointer', color: '#0D0D0D',
            boxShadow: '4px 4px 0 0 var(--edge-accent-bottom)',
            transition: 'transform var(--dur-press) var(--ease-mech), box-shadow var(--dur-press) var(--ease-mech)',
          }}
        >
          <Icon name="plus" size={17} strokeWidth={2.5} />
          <span style={{ ...caps('11px', '0.16em'), fontWeight: 800 }}>Set a trigger</span>
        </button>
      </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', borderTop: '1px solid var(--divider)', background: 'var(--surface-card)', flex: 'none' }}>
        {TABS_LEFT.map(tabButton)}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 0' }}>
          <button
            type="button"
            onClick={() => flashToast('Scan', 'Scanner lives on the home tab.')}
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

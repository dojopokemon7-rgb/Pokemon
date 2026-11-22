import { useState } from 'react'
import Icon from './Icon.jsx'
import { DojoWordmark } from './Logo.jsx'
import charizardImg from '../assets/floor/charizard.webp'

/*
 * Portfolio Home — the app dashboard. Implemented from
 * "Portfolio Home - iPhone.dc.html" in the claude.ai/design project
 * "iPhone screen mockup" (648a5228…). INR variant, gold hero.
 * Interactive: chart range tabs, bottom nav.
 */

const DELTA_ABS = { '1W': '+₹17,340', '1M': '+₹92,940', '3M': '+₹67,450', '1Y': '+₹3,20,180', ALL: '+₹5,65,540' }

const CHART = {
  '1W': { pts: [30, 34, 31, 38, 36, 41, 44], pct: '+2.1%' },
  '1M': { pts: [22, 26, 24, 30, 28, 34, 31, 38, 41, 39, 44, 48], pct: '+12.4%' },
  '3M': { pts: [34, 30, 33, 28, 26, 30, 27, 33, 38, 41, 44, 48], pct: '+8.7%' },
  '1Y': { pts: [12, 16, 20, 18, 26, 24, 31, 29, 36, 40, 44, 48], pct: '+61.2%' },
  ALL: { pts: [6, 9, 14, 12, 18, 24, 22, 30, 34, 40, 44, 48], pct: '+204%' },
}

const MOVERS = [
  { name: 'Luffy Gear 5 · Alt Art', tag: 'Top gainer · OP-05', price: '₹78,400', delta: '+9.4%', up: true },
  { name: 'Shanks SEC', tag: 'Top loser · OP-01', price: '₹52,100', delta: '−2.1%', up: false },
]

const TABS = [
  { id: 'dash', icon: 'house', label: 'Dash' },
  { id: 'portfolio', icon: 'layers', label: 'Portfolio' },
  { id: 'discover', icon: 'search', label: 'Discover' },
  { id: 'alerts', icon: 'bell', label: 'Alerts' },
  { id: 'profile', icon: 'user', label: 'Profile' },
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

export default function PortfolioScreen() {
  const [range, setRange] = useState('1M')
  const [tab, setTab] = useState('dash')

  const chart = CHART[range]
  const w = 330
  const h = 64
  const lo = 4
  const hi = 52
  const step = w / (chart.pts.length - 1)
  const yOf = (p) => h - 4 - ((p - lo) / (hi - lo)) * (h - 10)
  const chartPoints = chart.pts.map((p, i) => `${(i * step).toFixed(1)},${yOf(p).toFixed(1)}`).join(' ')
  const chartDotY = (yOf(chart.pts[chart.pts.length - 1]) - 3).toFixed(1)

  return (
    <div
      data-screen-label="Portfolio Home"
      style={{
        width: 390, height: 844, display: 'flex', flexDirection: 'column', position: 'relative',
        overflow: 'hidden', border: '1px solid var(--stroke-card)', background: 'var(--surface-app)',
        fontFamily: 'var(--font-body)', textAlign: 'left',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 30px 0', flex: 'none' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>9:41</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 8, letterSpacing: '0.14em', color: 'var(--text-body)' }}>◆ ◆ ◆</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 26px 0', flex: 'none' }}>
        {/* the header bar is far under the full lockup's 120px floor, so it
            carries the wordmark on its own */}
        <span style={{ display: 'flex', color: 'var(--text-heading)' }}>
          <DojoWordmark width={62} title="Dojo" />
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 18, alignItems: 'center', color: 'var(--text-subheading)' }}>
          <Icon name="search" size={18} strokeWidth={1.75} />
          <div style={{ position: 'relative', display: 'flex' }}>
            <Icon name="bell" size={18} strokeWidth={1.75} />
            <div style={{ position: 'absolute', top: -1, right: -2, width: 6, height: 6, background: 'var(--negative)' }} />
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '14px 26px 0', minHeight: 0 }}>
        {/* gold hero */}
        <div style={{ flex: 'none', background: 'var(--accent)', boxShadow: '6px 6px 0 0 var(--edge-accent-bottom)', padding: '16px 20px', margin: '0 6px 6px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ ...caps('9.5px', '0.18em'), color: 'rgba(13,13,13,0.55)' }}>Portfolio value · INR</div>
            <div style={{ marginLeft: 'auto', ...caps('9.5px'), color: 'rgba(13,13,13,0.45)' }}>228 items</div>
          </div>
          <div style={{ marginTop: 7, display: 'flex', alignItems: 'baseline' }}>
            <span style={{ ...num(41), lineHeight: 1, color: '#0D0D0D' }}>₹8,42,660</span>
          </div>
          <div style={{ marginTop: 11, ...caps('10px', '0.12em'), color: '#0D0D0D', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            ▲ {DELTA_ABS[range]} · {chart.pct} · {range}
          </div>
          <div style={{ marginTop: 6, ...caps('8.5px', '0.12em'), color: 'rgba(13,13,13,0.45)', whiteSpace: 'nowrap' }}>182 cards · 32 sealed · 14 graded</div>
        </div>

        {/* chart */}
        <div style={{ flex: 'none', background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', padding: '14px 14px 4px', marginTop: 12 }}>
          <svg width="100%" viewBox="0 0 330 64" style={{ display: 'block' }} aria-label={`portfolio chart, ${range}, ${chart.pct}`}>
            <line x1="0" y1="63" x2="330" y2="63" stroke="var(--divider)" strokeWidth="1" />
            <line x1="0" y1="32" x2="330" y2="32" stroke="var(--divider)" strokeWidth="1" strokeDasharray="2 5" />
            <polyline points={chartPoints} fill="none" stroke="var(--positive)" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />
            <rect x="325" y={chartDotY} width="7" height="7" fill="var(--positive)" />
          </svg>
          <div style={{ display: 'flex', marginTop: 8 }}>
            {Object.keys(CHART).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                style={{
                  flex: 1, textAlign: 'center', padding: '9px 0 7px', cursor: 'pointer', background: 'none', border: 'none',
                  ...caps('9.5px'),
                  color: r === range ? 'var(--text-heading)' : 'var(--text-faint)',
                  borderBottom: `2px solid ${r === range ? 'var(--accent)' : 'transparent'}`,
                  transition: 'color 150ms ease, border-color 150ms ease',
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* today's movers */}
        <div style={{ flex: 'none', display: 'flex', alignItems: 'baseline', marginTop: 14, marginBottom: 2 }}>
          <div style={{ ...caps('10px', '0.18em'), fontWeight: 800, color: 'var(--text-subheading)' }}>Today in your portfolio</div>
          <div style={{ marginLeft: 'auto', ...caps('9px'), color: 'var(--accent)', cursor: 'pointer' }}>All ›</div>
        </div>
        {MOVERS.map((it) => (
          <div key={it.name} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 13, padding: '10px 0', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, lineHeight: 1.25, color: 'var(--text-heading)' }}>{it.name}</div>
              <div style={{ marginTop: 2, ...caps('7.5px'), color: it.up ? 'var(--positive)' : 'var(--negative)' }}>{it.tag}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ ...num(14), color: 'var(--text-heading)' }}>{it.price}</div>
              <div style={{ marginTop: 3, ...caps('9px'), color: it.up ? 'var(--positive)' : 'var(--negative)', fontVariantNumeric: 'tabular-nums' }}>
                {it.up ? '▲' : '▼'} {it.delta}
              </div>
            </div>
          </div>
        ))}

        {/* P&L strip */}
        <div style={{ flex: 'none', display: 'flex', background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', marginTop: 12 }}>
          <div style={{ flex: 1, padding: '10px 14px' }}>
            <div style={{ ...caps('7.5px'), color: 'var(--text-faint)' }}>Invested</div>
            <div style={{ marginTop: 4, ...num(15), color: 'var(--text-heading)' }}>₹6,10,200</div>
          </div>
          <div style={{ flex: 1.2, padding: '10px 14px', borderLeft: '1px solid var(--divider)' }}>
            <div style={{ ...caps('7.5px'), color: 'var(--text-faint)' }}>Unrealized P&amp;L</div>
            <div style={{ marginTop: 4, ...num(15), color: 'var(--positive)' }}>+₹2,32,460</div>
          </div>
          <div style={{ flex: 0.8, padding: '10px 14px', borderLeft: '1px solid var(--divider)' }}>
            <div style={{ ...caps('7.5px'), color: 'var(--text-faint)' }}>Return</div>
            <div style={{ marginTop: 4, ...num(15), color: 'var(--positive)' }}>+38.1%</div>
          </div>
        </div>

        {/* buy trigger */}
        <div style={{ flex: 'none', background: 'var(--surface-card)', border: '1px solid var(--stroke-card)', boxShadow: '6px 6px 0 0 #067A4F', padding: '11px 16px', margin: '12px 6px 0 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>
                <Icon name="bell" size={12} strokeWidth={2.25} />
              </span>
              <span style={{ ...caps('9px', '0.18em'), fontWeight: 800, color: 'var(--text-heading)' }}>Buy trigger</span>
            </div>
            <span style={{ ...caps('8px'), color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>Target ₹95,000</span>
          </div>
          <div style={{ display: 'flex', gap: 13, marginTop: 10 }}>
            <div style={{ width: 46, flex: 'none', aspectRatio: '5/7', background: '#000', border: '1px solid var(--stroke-card)', overflow: 'hidden', boxShadow: '3px 3px 0 0 var(--edge-bottom)' }}>
              <img src={charizardImg} alt="Charizard ex" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', transform: 'scale(1.04)', display: 'block' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...caps('7.5px', '0.12em'), fontWeight: 800, color: '#0D0D0D', background: 'var(--jade-500)', padding: '2px 6px 1px' }}>WTS</span>
              </div>
              <div style={{ marginTop: 6, fontFamily: 'var(--font-display)', fontWeight: 800, fontStretch: '87%', fontSize: 17, lineHeight: 1, color: 'var(--text-heading)' }}>Charizard ex</div>
              <div style={{ marginTop: 5, ...caps('8px', '0.1em'), color: 'var(--text-body)', whiteSpace: 'nowrap' }}>SV 151 · 199/165 · SIR · PSA 10</div>
            </div>
            <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'right' }}>
              <div style={{ ...caps('8px'), color: 'var(--text-faint)' }}>Ask</div>
              <div style={{ marginTop: 3, display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6 }}>
                <span style={{ ...caps('11px', '0.02em'), color: 'var(--positive)' }}>▼</span>
                <span style={{ ...num(22), lineHeight: 0.9, color: 'var(--text-heading)' }}>₹94,200</span>
              </div>
            </div>
          </div>
          <div style={{ height: 1, background: 'var(--divider)', margin: '11px 0 9px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ display: 'inline-flex', color: 'var(--accent)', flex: 'none' }}>
              <Icon name="shield-check" size={15} strokeWidth={2} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ ...caps('8.5px'), fontWeight: 800, color: 'var(--text-subheading)', whiteSpace: 'nowrap' }}>Slabs and Foils</div>
              <div style={{ marginTop: 3, ...caps('7.5px', '0.12em'), color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>Dojo verified · 2h ago</div>
            </div>
            <button
              type="button"
              style={{
                marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 7,
                background: 'var(--accent)', color: '#0D0D0D', border: 'none', cursor: 'pointer',
                padding: '9px 13px', boxShadow: '3px 3px 0 0 var(--edge-accent-bottom)',
                ...caps('9px', '0.12em'), fontWeight: 800,
              }}
            >
              Offer
              <svg width="16" height="8" viewBox="0 0 18 8" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M0 4h16M13 1l3 3-3 3" strokeLinecap="square" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* tab bar */}
      <div style={{ display: 'flex', borderTop: '1px solid var(--divider)', background: 'var(--surface-card)', flex: 'none', marginTop: 12 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
              padding: '12px 0 10px', cursor: 'pointer', background: 'none', border: 'none',
              color: tab === t.id ? 'var(--text-heading)' : 'var(--text-faint)',
              borderTop: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`, marginTop: -1,
            }}
          >
            <Icon name={t.icon} size={18} strokeWidth={1.75} />
            <span style={caps('7px', '0.16em')}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

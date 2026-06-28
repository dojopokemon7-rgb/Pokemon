import React, { useState } from 'react';
import UserProfile from './components/UserProfile';
import CardScanner from './components/CardScanner';
import './App.css';

const TABS = [
  { id: 'profile', label: '🗂️ My Collection' },
  { id: 'scanner', label: '📷 Scan a Card'   },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('profile');

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-logo">⚡ PokéScan</h1>
        <p className="app-tagline">OCR-powered Pokémon TCG card identifier &amp; portfolio tracker</p>
      </header>

      {/* Tab bar */}
      <nav className="app-tabs" role="tablist">
        {TABS.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`app-tab ${activeTab === tab.id ? 'app-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            id={`tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {activeTab === 'profile' && <UserProfile />}
        {activeTab === 'scanner' && (
          <CardScanner
            onResult={(r) => console.log('Standalone scan:', r)}
            onError={(e)  => console.warn('Scan error:', e)}
          />
        )}
      </main>
    </div>
  );
}

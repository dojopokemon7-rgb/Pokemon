import React from 'react'
import ReactDOM from 'react-dom/client'
import LazyConsentBanner from './components/LazyConsentBanner.jsx'
import Privacy from './pages/Privacy.jsx'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <>
      <Privacy />
      <LazyConsentBanner />
    </>
  </React.StrictMode>
)

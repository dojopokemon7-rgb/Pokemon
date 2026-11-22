import React from 'react'
import ReactDOM from 'react-dom/client'
import LazyConsentBanner from './components/LazyConsentBanner.jsx'
import App from './App.jsx'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <>
      <App />
      <LazyConsentBanner />
    </>
  </React.StrictMode>
)

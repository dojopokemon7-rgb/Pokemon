import React from 'react'
import ReactDOM from 'react-dom/client'
import LazyConsentBanner from './components/LazyConsentBanner.jsx'
import GradingServices from './pages/GradingServices.jsx'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/grading.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <>
      <GradingServices />
      <LazyConsentBanner />
    </>
  </React.StrictMode>
)

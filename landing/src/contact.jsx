import React from 'react'
import ReactDOM from 'react-dom/client'
import LazyConsentBanner from './components/LazyConsentBanner.jsx'
import Contact from './pages/Contact.jsx'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/grading.css' // shares the .gform form styles with the grading page
import './styles/contact.css'
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <>
      <Contact />
      <LazyConsentBanner />
    </>
  </React.StrictMode>
)
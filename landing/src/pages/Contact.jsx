import BeamsBackground from '../components/BeamsBackground.jsx'
import ContactForm from '../components/ContactForm.jsx'
import Nav from '../sections/Nav.jsx'
import Footer from '../sections/Footer.jsx'
const PAGE_LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/grading-services', label: 'CGC grading' },
]
export default function Contact() {
  return (
    <>
      <BeamsBackground intensity="subtle" />
      <Nav links={PAGE_LINKS} current="/contact" />
      <main className="contact">
        <div className="container contact__inner">
          <p className="t-caps doc__eyebrow">
            <span className="glyph-gold" aria-hidden="true">◆</span> Dojo — a NODWIN Gaming business
          </p>
          <h1 className="doc__title">Contact us</h1>
          <p className="contact__lead">
            Questions, feedback or a partnership idea? Send us a message and the Dojo team will
            reply by email.
          </p>
          <ContactForm />
        </div>
      </main>
      <Footer />
    </>
  )
}
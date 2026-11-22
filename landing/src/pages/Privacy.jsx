import Logo from '../components/Logo.jsx'
import Footer from '../sections/Footer.jsx'

/* Standalone policy page — its own Vite entry, so it carries none of the
   landing page's device mockups, lottie or parallax. Bar is a plain link home
   rather than the site nav, since the section anchors don't exist here. */
export default function Privacy() {
  return (
    <>
      <header className="doc-bar">
        <div className="container doc-bar__inner">
          <a className="doc-bar__home" href="/" aria-label="Dojo — back to home">
            <Logo />
          </a>
          <a className="t-caps doc-bar__back" href="/">
            ← Back to site
          </a>
        </div>
      </header>

      <main className="doc">
        <div className="container doc__inner">
          <p className="t-caps doc__eyebrow">
            <span className="glyph-gold" aria-hidden="true">◆</span> Dojo — a NODWIN Gaming business
          </p>
          <h1 className="doc__title">Privacy Policy</h1>
          <p className="t-caps doc__updated">
            Last updated: <span className="num">3 August 2026</span>
          </p>

          <p>
            We are committed to protecting your privacy and your right to informational
            self-determination. We kindly ask you to take a moment and read this privacy policy
            (“Privacy Policy”). The information provided here will help you understand how and why we
            process your personal data.
          </p>
          <p>
            Dojo is a business of NODWIN Gaming Pvt. Ltd. (“NODWIN Gaming”). The Dojo website,
            applications, marketplace, events and related digital properties (together, the “Dojo
            Platform”) are owned and operated by NODWIN Gaming Pvt. Ltd. This Privacy Policy governs
            the Personal Data we process through the Dojo Platform and forms part of NODWIN Gaming's
            overall privacy framework.
          </p>
          <p>
            Our website may contain links to websites of other organizations. This privacy notice
            does not cover how those organizations process your Personal Data. We encourage you to
            read the privacy notices on the other websites you visit. If you have any questions
            regarding our use of your Personal Data, please feel free to contact us over the channels
            provided below.
          </p>
          <p>
            This Privacy Policy is published in compliance with, inter alia, the Information
            Technology Act, 2000, the Information Technology (Reasonable Security Practices and
            Procedures and Sensitive Personal Information) Rules, 2011; the Information Technology
            (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021, General Data
            Protection Regulation (“GDPR”), and the Digital Personal Data Protection Act, 2023
            (“DPDPA”).
          </p>
          <p>
            Throughout this document, the terms “we”, “us”, “our” and “ours” refer to NODWIN Gaming
            Pvt. Ltd., operating the Dojo Platform, and/or our sister concerns. The terms “you”,
            “your” and “yours” refer to YOU (the individual whose Personal Data we are referring to).
            We process any Personal Data we collect from you in accordance with the provisions of this
            Privacy Policy.
          </p>
          <p>
            By accessing this website or availing our services you confirm that you have the capacity
            to enter into a legally binding contract either by yourself or as a legal guardian, and,
            have read and understood all the terms set out in this Privacy Policy and agree to be
            bound by this Privacy Policy. If you are accessing or using our services from an overseas
            location, you do so at your own risk, and shall be solely liable for compliance with any
            applicable local laws.
          </p>
          <p>
            If you do not agree with this Privacy Policy at any time, in part or as a whole, do not
            use our services or otherwise provide us with any of your information.
          </p>
          <p>
            By providing your consent or when you provide any Personal Data to us for availing our
            services, you acknowledge that your information will be stored, used and accessed in
            accordance with this Privacy Policy.
          </p>

          <h2 className="doc__h2">What Personal Data do we collect &amp; process?</h2>
          <ul className="doc__list">
            <li>
              When you Sign In or register on the Dojo Platform, we collect Personal Data such as
              contact details which include your name, phone number, email address, etc.
            </li>
            <li>
              When you use our service, we collect data based on your choices and nature of services
              consumed to process it within our business logic. For example, under certain
              circumstances it is possible that we offer assistance to you regarding the planning of
              your participation in any of our event and/or tournaments which can include such
              questions regarding your details for your flights and/or accommodation and also
              including if you have any health conditions that require you to follow a certain diet
              (e.g. allergies) and other health-related conditions (e.g. disabilities that require
              special accessibility in a venue) relevant to the participation and you choose to share
              this information with us, we process this Personal Data of yours.
            </li>
            <li>
              When you buy, sell, grade, authenticate, consign, trade or otherwise transact in
              collectibles or trading cards through the Dojo Platform, we collect transaction and
              fulfilment data such as order and listing details, payment and settlement information,
              billing and shipping addresses, and KYC details where required by applicable law.
            </li>
            <li>
              When you visit and browse through our website, we may collect Personal Data through
              online identifiers and other technical data like IP address, transaction logs, and
              device details.
            </li>
            <li>
              Any other information required from your end, is communicated to you through the terms
              and conditions that you agree to while consumption of the services.
            </li>
          </ul>

          <h2 className="doc__h2">Definitions</h2>
          <ol className="doc__list doc__list--num">
            <li>
              <strong>Personal Data</strong> means any information relating to an identified or
              identifiable natural person (‘data subject’); an identifiable natural person is one who
              can be identified, directly or indirectly, in particular by reference to an identifier
              such as a name, an identification number, location data, an online identifier or to one
              or more factors specific to the physical, physiological, genetic, mental, economic,
              cultural or social identity of that natural person. We may from time to time also
              collect certain personal data such as your financial information or health information
              which constitutes “Sensitive Personal Data and Information” as defined under the laws.
            </li>
            <li>
              <strong>‘processing/process’</strong> means any operation or set of operations which is
              performed on Personal Data or on sets of Personal Data, whether or not by automated
              means, such as collection, recording, organisation, structuring, storage, adaptation or
              alteration, retrieval, consultation, use, disclosure by transmission, dissemination or
              otherwise making available, alignment or combination, restriction, erasure or
              destruction;
            </li>
            <li>
              <strong>‘Controller’</strong> means the natural or legal person, public authority,
              agency or other body which, alone or jointly with others, determines the purposes and
              means of the processing of Personal Data; where the purposes and means of such
              processing are determined by Union or Member State law, the controller or the specific
              criteria for its nomination may be provided for by Union or Member State law;
            </li>
            <li>
              <strong>‘Dojo’ or ‘Dojo Platform’</strong> means the Dojo brand, website, applications,
              marketplace, tournaments, events and related digital properties owned and operated by
              NODWIN Gaming Pvt. Ltd. References to Dojo in this Privacy Policy are references to
              NODWIN Gaming Pvt. Ltd. acting as Controller of your Personal Data.
            </li>
          </ol>

          <h2 className="doc__h2">Where do we obtain your Personal Data from?</h2>
          <ul className="doc__list">
            <li>
              The Personal Data that you provide when you register for our service and, further,
              during usage of our service;
            </li>
            <li>
              The Personal Data that gets collected in the background and/or is observed about you
              during usage of our service; and
            </li>
            <li>The Personal Data that gets generated during usage of our service.</li>
            <li>
              We process the Personal Data you provide when applying for a job or to work together
              with us as a freelancer.
            </li>
            <li>
              If we communicate with you via email, mail or telephone, we process all Personal Data
              you disclose to us during our conversation;
            </li>
            <li>
              Apart from this, it is also possible that we use other online messaging systems to
              communicate with you, if you wish to contact us over these channels. Please note that if
              you wish to contact us via such messaging systems, it is possible that the respective
              companies that offer these communication services may also process your Personal Data
              and that regarding this their privacy policies apply. We have no influence over such
              data processing by third parties. For further information on how these services process
              your Personal Data, please view their privacy policies.
            </li>
            <li>
              If you have not given us the data yourself, we would like to inform you that the sources
              of the mentioned data can be another person that acts on your behalf (e.g. you are a
              player or other personnel of a participating team and a team manager from your team
              would have provided your data to us).
            </li>
          </ul>

          <h2 className="doc__h2">How and why do we use your Personal Data?</h2>
          <ul className="doc__list">
            <li>To verify your identity;</li>
            <li>To deliver our services;</li>
            <li>
              To process, fulfil and settle your transactions on the Dojo Platform, including orders,
              listings, consignments, grading and authentication requests, shipping and returns;
            </li>
            <li>To communicate with you regarding existing services availed by you;</li>
            <li>To evaluate, develop and improve our services;</li>
            <li>For product analysis;</li>
            <li>To send you information about our other services which may be of interest to you;</li>
            <li>To handle enquiries and complaints;</li>
            <li>To comply with legal or regulatory requirements;</li>
            <li>
              We process your bank details (e.g. IBAN, BIC etc.) to make any payments (if necessary,
              as per the terms and conditions) to you; or
            </li>
            <li>
              To investigate, prevent, or act regarding illegal activities, suspected fraud,
              counterfeit or misrepresented collectibles.
            </li>
            <li>
              During our tournament(s) and events we process your Personal Data (e.g. name, nickname,
              nationality) by publicly displaying the information. If you are a player or other
              associated personnel of a participating team that publicly acts for the team (e.g. in
              interviews), we additionally publicly broadcast and, if applicable, present live on a
              stage your visual image and spoken word to the audience of such tournaments during and
              after the tournament (e.g. in recaps) in videos and photos.
            </li>
          </ul>

          <h2 className="doc__h2">Lawful bases of processing your Personal Data</h2>
          <p>We process your Personal Data by relying on one or more of the following lawful bases:</p>
          <ul className="doc__list">
            <li>You have consented to us processing your Personal Data for specified reasons; or</li>
            <li>
              The processing is necessary for compliance with a legal obligation we have (for example,
              towards law enforcement agencies, government agencies, regulators, etc).
            </li>
            <li>
              the processing is necessary to protect our legitimate interests or legitimate interests
              of a third party and such legitimate interests are not outweighed by your interests or
              fundamental rights and freedoms.
            </li>
            <li>
              the processing is necessary for the performance of a contract between you and us or in
              order to take steps at your request prior to entering into a contract.
            </li>
            <li>
              the data is processed for employment-related purposes, e.g. for hiring, carrying out or
              terminating an employment contract.
            </li>
            <li>
              you have given explicit consent to the processing of special categories of Personal Data
              (e.g. data concerning health) for one or more specified purposes.
            </li>
          </ul>
          <p>
            You provide all information to us voluntarily. Collection, use and disclosure of Personal
            Data requires your express consent. You are providing us with your consent to our
            processing, use, collection, and disclosure of the Personal Data which belongs to you or
            any person whom you are authorized to represent.
          </p>

          <h2 className="doc__h2">Your rights</h2>
          <ol className="doc__list doc__list--num">
            <li>
              <strong>Right of information:</strong> You have the right to be provided information
              regarding the processing of your Personal Data by us.
            </li>
            <li>
              <strong>Right of access:</strong> You have the right to obtain confirmation as to
              whether or not we are processing your Personal Data and, if this should be the case,
              access to the Personal Data.
            </li>
            <li>
              <strong>Right to rectification:</strong> You have the right to obtain rectification of
              inaccurate or incomplete Personal Data concerning you.
            </li>
            <li>
              <strong>Right to withdraw consent:</strong> You have the right to withdraw your consent
              at any point in time. Upon receipt of your request to withdraw your consent, the
              consequences of withdrawal will be communicated to you. In many cases, upon such a
              withdrawal, we may not be able to continue offering our products and services to you.
              You may withdraw consent by contacting us at{' '}
              <a href="mailto:unsubscribe@nodwin.com">unsubscribe@nodwin.com</a>. Such withdrawal does
              not affect the lawfulness of processing based on consent before its withdrawal.
            </li>
            <li>
              <strong>Right to erasure (“right to be forgotten”):</strong> Under certain circumstances
              you have the right to obtain the erasure of Personal Data concerning you. When you
              request for deletion of your data, we follow a deletion process to make sure that your
              data is safely and completely removed from our servers or retained only in anonymized
              form. We try to ensure that our services protect information from accidental or
              malicious deletion. Because of this, there may be delays between when you request to
              delete something and when copies are deleted from our active and backup systems.
            </li>
            <li>
              <strong>Right to restriction:</strong> Under certain circumstances you have the right to
              obtain the restriction of processing.
            </li>
            <li>
              <strong>Right to data portability:</strong> Under certain circumstances you have the
              right to receive the Personal Data concerning you, which you have provided to us, in a
              structured, commonly used and machine-readable format and the right to transmit this
              data to another Controller.
            </li>
            <li>
              <strong>Right to object:</strong> Under certain circumstances you have the right to
              object to the processing of Personal Data concerning you.
            </li>
            <li>
              <strong>Right to lodge a complaint:</strong> You have the right to lodge a complaint with
              a supervisory authority i.e. the Grievance Officer, for the alleged infringement if you
              consider that the processing of Personal Data relating to you infringes the rights
              provided to you under law.
            </li>
          </ol>
          <p>
            If you want to exercise your rights or if you have any questions for us regarding the
            processing of your Personal Data, please reach out to our Grievance Officer.
          </p>

          <h2 className="doc__h2">Privacy of minors (Section 9 of the DPDPA)</h2>
          <p>
            To access or use this website you must be 18 years of age or older and, if under 18 or the
            age of minority in your jurisdiction, your use of this website must be under the
            supervision or approval of a parent or guardian or other responsible adult.
          </p>
          <p>
            If you become aware that a child has provided us with personal information without
            parental/guardian consent, please feel free to reach out to us.
          </p>

          <h2 className="doc__h2">When do we share your Personal Data with third parties?</h2>
          <p>
            We may disclose your Personal Data to third parties only where it is lawful to do so. We
            may disclose your Personal Data to the following third parties:
          </p>
          <ul className="doc__list">
            <li>
              NODWIN Gaming Pvt. Ltd., its holding company, subsidiaries and other group companies
              that are essential to hosting and distributing our content and operating the Dojo
              Platform.
            </li>
            <li>
              agents or service providers who work for us or provide services or products to us,
              including payment gateways, logistics and fulfilment partners, and grading or
              authentication partners engaged for the Dojo Platform.
            </li>
            <li>
              Law enforcement authorities, government authorities, courts, dispute resolution bodies,
              regulators, auditors, and any party appointed or requested by applicable regulators to
              carry out investigations or audits of our activities.
            </li>
            <li>
              Any third party to which we transfer or sell our assets, merge or consolidate with, will
              have the right to continue to use the Personal Data provided to us by you, in accordance
              with the Terms of Use and this Privacy Policy.
            </li>
          </ul>

          <h2 className="doc__h2">Cross-border data transfer</h2>
          <p>
            Personal Data we hold about you may be transferred to other countries outside of India for
            any of the purposes described in this Privacy Policy. You expressly provide your consent
            for transfer of such Personal Data outside India. Any Personal Data will be protected in
            accordance with this Privacy Policy as well as with adequate protections in place in
            compliance with applicable laws and regulations.
          </p>

          <h2 className="doc__h2">Use of cookies and other tracking mechanisms</h2>
          <p>
            We may use cookies and other tracking mechanisms on the Dojo Platform and other digital
            properties to collect data about you. We may also use trackers and analytics tools (google
            analytics) on our website and other digital properties to collect data about you. These
            trackers have their own privacy policy. This is primarily used to enhance the
            functionality of the app and to analyse it to serve you better.
          </p>

          <h2 className="doc__h2">How do we secure your Personal Data?</h2>
          <p>
            We are committed to protecting your Personal Data in our custody. We take reasonable steps
            to ensure appropriate physical, technical, and managerial safeguards are in place to
            protect your Personal Data from unauthorised access, alteration, transmission, and
            deletion. We ensure that the third parties who provide services to us under appropriate
            contracts take appropriate security measures to protect your Personal Data in line with
            our policies.
          </p>

          <h2 className="doc__h2">How long do we keep your Personal Data?</h2>
          <p>
            We keep the Personal Data we collect about you for as long as it is required for the
            purposes set out in this Privacy Policy and for legal or regulatory reasons.
          </p>

          <h2 className="doc__h2">Notification of changes</h2>
          <p>
            We regularly review and update our Privacy Policy to ensure it is up-to-date and accurate.
            We will not reduce your rights under this Privacy Policy without your explicit consent.
            Your continued use of this website, our services or providing us with your Personal Data
            or Sensitive Personal Data or Information will be considered your acceptance of such
            updated terms under the Privacy Policy.
          </p>

          <h2 className="doc__h2">Contact our Grievance Officer</h2>
          <p>
            In the event that you wish to make an inquiry and/or complaint about how your Personal
            Data is processed by us, then in accordance with the GDPR, Digital Personal Data
            Protection Act, 2023, the Information Technology Act, 2000 and the rules thereof, you can
            contact the Grievance Officer of NODWIN Gaming Pvt. Ltd., who also handles grievances
            relating to the Dojo Platform. The contact details of the Grievance Officer are provided
            below:
          </p>

          <dl className="doc__contact">
            <dt className="t-caps">Name</dt>
            <dd>Gautam Virk</dd>
            <dt className="t-caps">Address</dt>
            <dd>Plot No- 119, Sector 31, Gurgaon- 122001</dd>
            <dt className="t-caps">Email</dt>
            <dd>
              <a href="mailto:gautam.virk@nodwin.com">gautam.virk@nodwin.com</a>
            </dd>
          </dl>

          <p>
            Any feedback or comments about this Privacy Policy will be welcome, and can be sent to{' '}
            <a href="mailto:gautam.virk@nodwin.com">gautam.virk@nodwin.com</a>. We will employ all
            commercially reasonable efforts to address the same. If you are unhappy about how a
            complaint has been handled by us, you have a right to lodge a complaint directly with
            supervisory authority.
          </p>
        </div>
      </main>

      <Footer />
    </>
  )
}

import type { Metadata } from 'next';
import { ContactLine, LegalPage } from '@/components/legal-page';

export const metadata: Metadata = {
  title: 'Terms · YASHAYAH',
  description: 'The agreement between you and YASHAYAH, in plain words.',
};

/**
 * The terms of service.
 *
 * Short because the product is simple to describe: you bring your keys,
 * your documents and your tools, YASHAYAH runs assistants on them, and what
 * those assistants do is done at your instruction and with your approval.
 */
export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" effective="14 October 2026">
      <p className="legal-lede">
        These are the terms for using YASHAYAH. They are written to be read. If anything here is
        unclear, ask before you rely on it.
      </p>

      <h2>What YASHAYAH is</h2>
      <p>
        YASHAYAH lets you create assistants that answer in a browser, on chat platforms and out loud,
        read documents you give them, remember what you tell them, and act in services you
        connect. The assistants think with a model provider of your choice, under your own API
        key. YASHAYAH is the place they live; the thinking, and its cost, is between you and that
        provider.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be able to form a binding agreement to use YASHAYAH, and you are responsible for what happens under your account.</li>
        <li>Keep your password and your API keys to yourself. Tell us at once if you think either has been exposed.</li>
        <li>One person, one account. A workspace is how several people work together.</li>
      </ul>

      <h2>Your content and your keys</h2>
      <p>
        Everything you put into YASHAYAH stays yours: your documents, your conversations, your
        instructions, your credentials. You give us only the permission needed to store it, show
        it back to you, and send it where you asked it sent. We claim no other right in it. Our{' '}
        <a href="/privacy">privacy policy</a> says what we store and where.
      </p>
      <p>
        The API keys and tokens you enter are yours to provide and yours to revoke. Charges from a
        model provider or a connected service are made to your account with them, under their
        terms.
      </p>

      <h2>What assistants do</h2>
      <p>
        An assistant acts on your instruction. Before it does anything that writes, sends, spends
        or deletes, it asks a person in your workspace, and that person&rsquo;s answer decides it.
        You are responsible for the instructions you give, the documents you upload, the services
        you connect and the approvals you grant. An assistant can be wrong; read what it did before
        you rely on it, and set the spend caps that suit you.
      </p>

      <h2>What you may not do</h2>
      <ul>
        <li>Use YASHAYAH to break the law, to harass anyone, or to send unsolicited messages.</li>
        <li>Connect a service, a bot or an account you do not have the right to connect.</li>
        <li>Try to reach another workspace&rsquo;s data, or to interfere with the service.</li>
        <li>Resell access to YASHAYAH without an agreement with us.</li>
      </ul>

      <h2>Paying for YASHAYAH</h2>
      <p>
        Where a plan is offered, it is billed in advance for each period through a payment
        processor; card details never reach YASHAYAH. You can cancel at any time and keep what you
        paid for until the period ends. A deployment that offers no plan charges nothing.
      </p>

      <h2>Availability and changes</h2>
      <p>
        We work to keep YASHAYAH available and we tell you in the app before a change that matters.
        We may suspend an account that breaks these terms, after telling you why unless the law or
        the safety of others prevents it. You may leave at any time, and ask us to delete what you
        left behind.
      </p>

      <h2>Warranties and liability</h2>
      <p>
        YASHAYAH is provided as it is. We do not promise that an assistant&rsquo;s answers are right,
        that a connected service will stay connected, or that the service will be uninterrupted.
        To the extent the law allows, our liability to you is limited to what you paid us in the
        twelve months before the claim, and we are not liable for indirect or consequential loss.
        Nothing here limits liability that cannot be limited by law.
      </p>

      <h2>These terms</h2>
      <p>
        These terms are the whole agreement between you and us about YASHAYAH. If a part is found
        unenforceable, the rest stands. We may update them; the date at the top is the version in
        force, and continuing to use YASHAYAH after a change means accepting it.
      </p>

      <h2>Contact</h2>
      <ContactLine />
    </LegalPage>
  );
}

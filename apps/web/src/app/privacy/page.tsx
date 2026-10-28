import type { Metadata } from 'next';
import { ContactLine, LegalPage } from '@/components/legal-page';

export const metadata: Metadata = {
  title: 'Privacy · YASHAYAH',
  description: 'What YASHAYAH stores, where it stays, and what it never does with it.',
};

/**
 * The privacy policy.
 *
 * Written from how the system actually works, not from a template: every
 * sentence here corresponds to a decision in the code. The Google section
 * carries the Limited Use statement Google's API Services User Data Policy
 * requires of any app that touches Gmail, Calendar or Drive.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" effective="14 October 2026">
      <p className="legal-lede">
        YASHAYAH is a place where you run assistants on your own documents, your own tools and your
        own model keys. The shortest version of this policy is: your data goes into a database you
        control, it is used only to do what you asked, and nobody else is in between.
      </p>

      <h2>Who we are</h2>
      <p>
        YASHAYAH is operated by Yashayah.ai. When this policy says &ldquo;we&rdquo;, it means the people
        who run this deployment of YASHAYAH.
      </p>

      <h2>What we store</h2>
      <ul>
        <li><strong>Your account.</strong> Your email address, your name if you gave one, a password hash if you set a password, and when you signed in. If you sign in with Google, we store the email and name Google gives us and nothing else from your Google account.</li>
        <li><strong>Your workspace.</strong> Its name, who is in it and in what role, its settings, and its invitations.</li>
        <li><strong>Your assistants.</strong> Their names, instructions, routines and every version of each.</li>
        <li><strong>Conversations and runs.</strong> What you and your assistants said, what tools were used, what they returned, what each run cost, and the approvals you gave or refused.</li>
        <li><strong>Documents and memory.</strong> The documents you upload, the text taken from them, and what an assistant remembers about your business.</li>
        <li><strong>Credentials.</strong> Your model provider API keys, bot tokens, and the OAuth tokens that connect an assistant to a service such as Google Workspace or GitHub. Each is encrypted with its own key before it is stored, and is never shown again after you enter it.</li>
        <li><strong>An audit trail.</strong> Who did what in the workspace: changes to members, settings and connections, every approval, every tool call.</li>
      </ul>

      <h2>Where it stays</h2>
      <p>
        Everything above lives in the database this deployment is configured with. There is no
        analytics vendor, no identity broker, no data warehouse and no advertising network in
        YASHAYAH. We do not sell data, share it with third parties for their own purposes, or use it
        to train models.
      </p>
      <p>
        Three kinds of service do see parts of your data, each only to do what you asked:
      </p>
      <ul>
        <li><strong>The model provider you chose.</strong> When an assistant thinks, the conversation and the documents it needs are sent to OpenAI or Anthropic under your own API key and their terms, never ours.</li>
        <li><strong>The services you connect.</strong> When an assistant reads your mail or creates an issue, it talks to that service directly, with the access you granted on that service&rsquo;s own consent screen.</li>
        <li><strong>Our mail server.</strong> Verification codes and invitations are sent from our own mail server to the address you gave.</li>
      </ul>

      <h2>Google user data</h2>
      <p>
        If you connect Google Workspace to an assistant, YASHAYAH asks Google for permission to read
        and label your Gmail, read and create calendar events, and read your Drive files. It uses
        that access only to do what you or your assistant&rsquo;s routine asked: answer a question
        about your mail, draft a reply, book a slot, find a document. Nothing it reads is stored
        beyond the conversation it was read for, and the tokens that grant the access are
        encrypted and tied to the one assistant you connected.
      </p>
      <p>
        YASHAYAH&rsquo;s use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>,
        including the Limited Use requirements. In particular, Google user data is never used for
        advertising, never sold, never used to train models, and never read by a person except
        with your consent, for security, or where the law requires it.
      </p>
      <p>
        You can disconnect Google from any assistant on its Integrations tab. Doing so revokes the
        grant at Google and deletes the tokens here. You can also revoke it from your{' '}
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google account</a> at any time.
      </p>

      <h2>Chat platforms</h2>
      <p>
        If you connect Telegram, Discord or Slack, YASHAYAH stores the bot token you gave, encrypted,
        and the platform&rsquo;s identifier for each chat and person who writes to the assistant.
        Messages sent to the bot become part of a conversation like any other. Linking a chat
        account to your YASHAYAH account is your choice and can be undone in Settings.
      </p>

      <h2>Approvals and the record</h2>
      <p>
        Before an assistant does anything that writes, sends, spends or deletes, it asks a person.
        The answer, who gave it and when are kept. So is a record of every run: what it did, what
        it used and what it cost. This record exists so that you can see what your assistants did,
        and it is yours.
      </p>

      <h2>Your rights</h2>
      <ul>
        <li><strong>See it.</strong> Everything an assistant did is on its Activity page. Everything stored about an assistant is on its tabs.</li>
        <li><strong>Correct it.</strong> Documents, memories, instructions and settings can be edited or removed in the app.</li>
        <li><strong>Delete it.</strong> Disconnecting a service deletes its tokens. Deleting a document deletes its text. Ask us to delete your account and workspace and we will, along with everything in them.</li>
        <li><strong>Take it.</strong> Documents can be downloaded as the files you uploaded. Ask us for the rest and we will export it.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        YASHAYAH sets one cookie to keep you signed in, and a short-lived one while a consent flow is
        in progress so that the service you are connecting can send you back to the right place.
        There are no tracking cookies.
      </p>

      <h2>Security</h2>
      <p>
        Credentials are encrypted with a per-credential key wrapped by a master key held outside
        the database. Every database query is scoped to one workspace by construction. Sessions
        rotate and can be revoked everywhere at once. Deliveries from chat platforms are verified
        by signature before anything acts on them. None of this makes a system perfect; it makes
        the ordinary mistakes hard to make.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that matters, we will say so in the app before it takes
        effect. The date at the top is the version you are reading.
      </p>

      <h2>Contact</h2>
      <ContactLine />
    </LegalPage>
  );
}

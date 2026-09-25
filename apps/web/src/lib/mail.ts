/**
 * Outgoing mail.
 *
 * Spoken directly to the mail server named in the environment, over SMTP.
 * There is no mail vendor in between: the address, the code and the fact
 * that a message was sent go to your own server and nowhere else. A
 * deployment with no server configured sends nothing and says so, rather
 * than swallowing the message.
 */
import nodemailer from 'nodemailer';
import { env } from './env';

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export const mailConfigured = (): boolean => env().SMTP_URL !== undefined && env().MAIL_FROM !== undefined;

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const url = env().SMTP_URL;
  const from = env().MAIL_FROM;
  if (url === undefined || from === undefined) throw new Error('Outgoing mail is not configured.');
  const transport = nodemailer.createTransport(url);
  await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
}

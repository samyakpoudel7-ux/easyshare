import nodemailer from 'nodemailer';

const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendReadReceipt(to, { noteId, at, ip, ua }) {
  if (!transport) return console.warn('SMTP not configured; read receipt skipped');
  await transport.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: 'Your secret note was opened',
    text:
      `A secret note you created (id ${noteId}) was opened.\n\n` +
      `Time: ${at.toISOString()}\nIP address: ${ip}\nBrowser: ${ua || 'unknown'}\n\n` +
      `If this wasn't expected, the link may have been shared further than intended.`,
  });
}

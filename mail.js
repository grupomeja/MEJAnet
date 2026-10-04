// Envío del aviso por correo.
// - Con RESEND_API_KEY usa la API de Resend por HTTPS (funciona en el plan gratis de Render,
//   que bloquea los puertos SMTP).
// - Si no, usa SMTP (SMTP_USER, SMTP_PASS) — solo funciona en planes de pago de Render.
const { formatoOC } = require('./oc');

function configurado() {
  return !!(process.env.MAIL_TO && (process.env.RESEND_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS)));
}

function contenido(reg) {
  const d = reg.datos;
  const oc = formatoOC(reg.oc);
  const llenas = (d.filas || []).filter((f) => f.trafico || f.bultos || f.pedimento || f.nota).length;
  return {
    oc,
    asunto: `Orden de carga OC # ${oc} - ${d.cliente || 'Sin cliente'} - ${d.fecha || ''}`.trim(),
    texto:
      `Se registró una nueva orden de carga.\n\nOC #: ${oc}\n` +
      `Cliente: ${d.cliente || ''}\nCaja / Placas: ${d.caja || ''}\nSello: ${d.sello || ''}\n` +
      `Fecha de cruce: ${d.fecha || ''}\nRenglones: ${llenas}\n` +
      (d.capturista ? `Capturó: ${d.capturista}\n` : '') +
      `\nEl PDF va adjunto.`,
    archivo: `ORDEN_DE_CARGA_${oc}.pdf`,
  };
}

async function porResend(c, pdf) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Orden de Carga <onboarding@resend.dev>',
        to: process.env.MAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
        subject: c.asunto,
        text: c.texto,
        attachments: [{ filename: c.archivo, content: pdf.toString('base64') }],
      }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  } finally {
    clearTimeout(t);
  }
}

async function porSMTP(c, pdf) {
  const nodemailer = require('nodemailer');
  const puerto = Number(process.env.SMTP_PORT || 465);
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: puerto,
    secure: puerto === 465,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporte.sendMail({
    from: `"Orden de Carga" <${process.env.SMTP_USER}>`,
    to: process.env.MAIL_TO,
    subject: c.asunto, text: c.texto,
    attachments: [{ filename: c.archivo, content: pdf }],
  });
}

// Devuelve true si se envió; lanza error si falla.
async function enviarOrden(reg, pdf) {
  if (!configurado()) throw new Error('Correo no configurado (falta RESEND_API_KEY o SMTP_USER/SMTP_PASS, y MAIL_TO)');
  const c = contenido(reg);
  if (process.env.RESEND_API_KEY) await porResend(c, pdf);
  else await porSMTP(c, pdf);
  return true;
}

module.exports = { enviarOrden, configurado };

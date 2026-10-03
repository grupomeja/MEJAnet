// Envía la orden por correo (si hay configuración SMTP).
const nodemailer = require('nodemailer');

function configurado() {
  return process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_TO;
}

async function enviarOrden(reg, pdfBuffer) {
  if (!configurado()) {
    console.warn('Correo no configurado (faltan SMTP_USER, SMTP_PASS o MAIL_TO). No se envió.');
    return false;
  }
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_PORT || '465') === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const d = reg.datos;
  const llenas = (d.filas || []).filter((f) => f.trafico || f.bultos || f.pedimento || f.nota).length;
  await transporte.sendMail({
    from: `"Orden de Carga" <${process.env.SMTP_USER}>`,
    to: process.env.MAIL_TO,
    subject: `Orden de carga #${reg.id} - ${d.cliente || 'Sin cliente'} - ${d.fecha || ''}`.trim(),
    text:
      `Se registró una nueva orden de carga.\n\n` +
      `Cliente: ${d.cliente || ''}\nCaja / Placas: ${d.caja || ''}\nSello: ${d.sello || ''}\n` +
      `Fecha de cruce: ${d.fecha || ''}\nRenglones: ${llenas}\n` +
      (d.capturista ? `Capturó: ${d.capturista}\n` : '') +
      `\nEl PDF va adjunto.`,
    attachments: [{ filename: `ORDEN_DE_CARGA_${reg.id}.pdf`, content: pdfBuffer }],
  });
  return true;
}

module.exports = { enviarOrden, configurado };

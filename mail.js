// Aviso por correo de Orden de Carga.
// El envío (remitente, destinatarios, Resend/SMTP) lo hace el servicio general de correo (correo.js),
// que se configura en /herramientas/correo.
const { formatoOC } = require('./oc');
const { enviarCorreo } = require('./correo');

function contenido(reg) {
  const d = reg.datos;
  const oc = formatoOC(reg.oc);
  const llenas = (d.filas || []).filter((f) => f.trafico || f.bultos || f.pedimento || f.nota).length;
  return {
    oc,
    asunto: `ORDEN DE CARGA #${oc} // ${d.cliente || 'SIN CLIENTE'} // FECHA DE CRUCE: ${d.fecha || 'PENDIENTE'}`,
    texto:
      `Se registró una nueva orden de carga.\n\nOC #: ${oc}\n` +
      `Cliente: ${d.cliente || ''}\nCaja / Placas: ${d.caja || ''}\nSello: ${d.sello || ''}\n` +
      `Fecha de cruce: ${d.fecha || ''}\nTraficos: ${llenas}\n` +
      (d.capturista ? `Capturó: ${d.capturista}\n` : '') +
      `\nEl PDF va adjunto.`,
    archivo: `ORDEN_DE_CARGA_${oc}.pdf`,
  };
}

// Devuelve true si se envió, false si el envío está apagado para Orden de Carga; lanza error si falla.
async function enviarOrden(reg, pdf) {
  const c = contenido(reg);
  const r = await enviarCorreo({
    modulo: 'orden-de-carga',
    asunto: c.asunto,
    texto: c.texto,
    adjuntos: [{ nombre: c.archivo, contenido: pdf }],
  });
  return r.enviado;
}

module.exports = { enviarOrden };

// Llena la plantilla ORDEN_DE_CARGA.pdf con los datos de una orden.
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const PLANTILLA = path.join(__dirname, 'templates', 'ORDEN_DE_CARGA.pdf');

async function generarPDF(d) {
  const pdf = await PDFDocument.load(fs.readFileSync(PLANTILLA));
  const form = pdf.getForm();
  const txt = (nombre, valor) => {
    try { form.getTextField(nombre).setText(String(valor ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')); } catch (_) {}
  };
  txt('CLIENTE', d.cliente);
  txt('CAJA / PLACAS', d.caja);
  txt('SELLO', d.sello);
  txt('FECHA DE CRUCE', d.fecha);

  (d.filas || []).slice(0, 20).forEach((f, i) => {
    const n = i + 1;
    txt(`TRAFICORow${n}`, f.trafico);
    txt(`BULTOSRow${n}`, f.bultos);
    txt(`PEDIMENTORow${n}`, f.pedimento);
    txt(`NOTARow${n}`, f.nota);
    for (const [campo, nombre] of [['separado', 'SEPARADO'], ['cargado', 'CARGADO']]) {
      try {
        const cb = form.getCheckBox(`${nombre}Row${n}`);
        f[campo] ? cb.check() : cb.uncheck();
      } catch (_) {}
    }
  });
  try { form.updateFieldAppearances(); form.flatten(); } catch (e) { console.error('No se pudo aplanar el PDF:', e.message); }
  return Buffer.from(await pdf.save());
}

module.exports = { generarPDF };

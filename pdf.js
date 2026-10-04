// Llena la plantilla ORDEN_DE_CARGA.pdf con los datos de una orden.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { formatoOC } = require('./oc');

const PLANTILLA = path.join(__dirname, 'templates', 'ORDEN_DE_CARGA.pdf');

async function generarPDF(d, id) {
  const pdf = await PDFDocument.load(fs.readFileSync(PLANTILLA));
  const form = pdf.getForm();
  if (id) {
    const fuente = await pdf.embedFont(StandardFonts.HelveticaBold);
    const texto = `OC # ${formatoOC(id)}`;
    const tam = 16;
    pdf.getPage(0).drawText(texto, {
      x: 590 - fuente.widthOfTextAtSize(texto, tam), y: 762, size: tam, font: fuente, color: rgb(0, 0, 0),
    });
  }
  const medida = await pdf.embedFont(StandardFonts.Helvetica);
  // Escribe el texto con letra de tamaño `max` y la reduce solo si no cabe en la celda.
  const txt = (nombre, valor, max = 11, min = 5) => {
    try {
      const campo = form.getTextField(nombre);
      const texto = String(valor ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
      const ancho = campo.acroField.getWidgets()[0].getRectangle().width - 6;
      let tam = max;
      while (tam > min && medida.widthOfTextAtSize(texto, tam) > ancho) tam -= 0.5;
      try { campo.setFontSize(tam); } catch (_) {}
      campo.setText(texto);
    } catch (_) {}
  };
  const CELDA = 8.5; // tamaño máximo de letra dentro de la tabla
  txt('CLIENTE', d.cliente);
  txt('CAJA / PLACAS', d.caja);
  txt('SELLO', d.sello);
  txt('FECHA DE CRUCE', d.fecha);

  (d.filas || []).slice(0, 20).forEach((f, i) => {
    const n = i + 1;
    txt(`TRAFICORow${n}`, f.trafico, CELDA);
    txt(`BULTOSRow${n}`, f.bultos, CELDA);
    txt(`PEDIMENTORow${n}`, f.pedimento, CELDA);
    txt(`NOTARow${n}`, f.nota, CELDA);
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

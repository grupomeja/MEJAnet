// Genera el PDF de una cotización (hoja carta) con pdf-lib, sin plantilla.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const AZUL = rgb(0.122, 0.306, 0.549);     // #1f4e8c
const VERDE = rgb(0.059, 0.541, 0.424);    // #0f8a6c
const GRIS = rgb(0.36, 0.40, 0.45);
const LINEA = rgb(0.84, 0.85, 0.87);
const SUAVE = rgb(0.94, 0.96, 0.97);
const NEGRO = rgb(0.08, 0.09, 0.11);

// Las fuentes estándar solo traen caracteres latinos; lo demás se cambia por "?"
const limpio = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
const dinero = (x) => (Number(x) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cant = (x) => (Number(x) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const fechaTxt = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '';
  const meses = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  return `${m[3]}/${meses[Number(m[2]) - 1]}/${m[1]}`;
};

async function generarPDFCotizacion(reg, calc, folio) {
  const d = reg.datos;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Cotizacion ${folio}`);
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const FB = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null;
  try { logo = await pdf.embedPng(fs.readFileSync(path.join(__dirname, 'public', 'logo.png'))); } catch (_) {}

  const W = 612, H = 792, M = 40;
  let page, y;

  const texto = (s, x, yy, { f = F, size = 9, color = NEGRO, align = 'left', maxW } = {}) => {
    let t = limpio(s);
    if (maxW && f.widthOfTextAtSize(t, size) > maxW) {
      while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
      t = `${t.trimEnd()}...`;
    }
    const w = f.widthOfTextAtSize(t, size);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(t, { x: xx, y: yy, size, font: f, color });
  };
  // Parte un texto en renglones que quepan en `ancho`
  const renglones = (s, ancho, f = F, size = 9) => {
    const out = [];
    for (const parrafo of limpio(s).split('\n')) {
      let linea = '';
      for (const palabra of parrafo.split(/\s+/)) {
        const prueba = linea ? `${linea} ${palabra}` : palabra;
        if (f.widthOfTextAtSize(prueba, size) <= ancho) linea = prueba;
        else {
          if (linea) out.push(linea);
          let p = palabra;
          while (f.widthOfTextAtSize(p, size) > ancho && p.length > 1) {
            let k = p.length; while (k > 1 && f.widthOfTextAtSize(p.slice(0, k), size) > ancho) k--;
            out.push(p.slice(0, k)); p = p.slice(k);
          }
          linea = p;
        }
      }
      out.push(linea);
    }
    return out;
  };

  function encabezado(primera) {
    page = pdf.addPage([W, H]);
    y = H - M;
    if (logo) {
      const h = 38, w = logo.width * (h / logo.height);
      page.drawImage(logo, { x: M, y: y - h, width: w, height: h });
    }
    texto('COTIZACIÓN', W - M, y - 14, { f: FB, size: 18, color: AZUL, align: 'right' });
    texto(folio, W - M, y - 30, { f: FB, size: 12, color: VERDE, align: 'right' });
    y -= 50;
    page.drawRectangle({ x: M, y, width: W - 2 * M, height: 2, color: AZUL });
    y -= 14;
    if (!primera) y -= 4;
  }

  function pie() {
    const pags = pdf.getPages();
    pags.forEach((p, i) => {
      const t = limpio(`${folio}  ·  Página ${i + 1} de ${pags.length}`);
      p.drawText(t, { x: W - M - F.widthOfTextAtSize(t, 7.5), y: 22, size: 7.5, font: F, color: GRIS });
      p.drawText('Grupo Meja', { x: M, y: 22, size: 7.5, font: FB, color: GRIS });
    });
  }

  encabezado(true);

  // ---- Datos generales: cliente (izq) y fechas (der) ----
  const colDer = W - M - 170;
  const filaDato = (etq, val, x, yy, ancho) => {
    texto(etq, x, yy, { f: FB, size: 7, color: GRIS });
    texto(val || '-', x, yy - 11, { size: 9.5, maxW: ancho });
  };
  filaDato('CLIENTE', d.cliente, M, y, colDer - M - 20);
  const vence = (() => {
    const f = new Date(`${d.fecha}T12:00:00`); if (isNaN(f)) return '';
    f.setDate(f.getDate() + (Number(d.vigencia) || 0)); return fechaTxt(f.toISOString());
  })();
  filaDato('FECHA', fechaTxt(d.fecha), colDer, y, 80);
  filaDato('VÁLIDA HASTA', vence, colDer + 88, y, 82);
  y -= 30;
  const contacto = [d.atencion && `At'n: ${d.atencion}`, d.correo, d.telefono].filter(Boolean).join('   ·   ');
  if (contacto) { filaDato('CONTACTO', contacto, M, y, colDer - M - 20); }
  if (d.tc) filaDato('TIPO DE CAMBIO', `$${d.tc} MXN por USD`, colDer, y, 170);
  if (contacto || d.tc) y -= 30;

  // ---- Datos del embarque ----
  const e = d.embarque || {};
  const datosEmb = [
    ['SERVICIO', e.servicio], ['ORIGEN', e.origen], ['DESTINO', e.destino], ['UNIDAD', e.unidad],
    ['MERCANCÍA', e.mercancia], ['PESO', e.peso_kg ? `${cant(e.peso_kg)} kg / ${cant(Number(e.peso_kg) * 2.20462)} lb` : ''],
    ['TARIMAS', e.tarimas], ['BULTOS', e.bultos], ['DÍAS', e.dias], ['KM', e.km],
    ['VALOR MERCANCÍA', e.valor ? `$${dinero(e.valor)} ${e.valor_moneda || 'USD'}` : ''],
  ].filter(([, v]) => String(v ?? '').trim());
  if (datosEmb.length) {
    const cols = 4, anchoCol = (W - 2 * M - 20) / cols, filas = Math.ceil(datosEmb.length / cols);
    const alto = 22 + filas * 24;
    page.drawRectangle({ x: M, y: y - alto + 4, width: W - 2 * M, height: alto, color: SUAVE });
    texto('DATOS DEL EMBARQUE', M + 10, y - 8, { f: FB, size: 8, color: AZUL });
    datosEmb.forEach(([k, v], i) => {
      const cx = M + 10 + (i % cols) * anchoCol, cy = y - 24 - Math.floor(i / cols) * 24;
      texto(k, cx, cy, { f: FB, size: 6.5, color: GRIS });
      texto(v, cx, cy - 10, { size: 8.5, maxW: anchoCol - 8 });
    });
    y -= alto + 18;
  }

  // ---- Tabla de partidas ----
  const C = { desc: M + 6, cant: M + 286, uni: M + 294, pu: M + 400, mon: M + 410, iva: M + 440, imp: W - M - 6 };
  const encTabla = () => {
    page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 18, color: AZUL });
    const o = { f: FB, size: 7.5, color: rgb(1, 1, 1) };
    texto('CONCEPTO', C.desc, y, o);
    texto('CANT.', C.cant, y, { ...o, align: 'right' });
    texto('UNIDAD', C.uni, y, o);
    texto('P. UNITARIO', C.pu, y, { ...o, align: 'right' });
    texto('MON.', C.mon, y, o);
    texto('IVA', C.iva, y, o);
    texto('IMPORTE', C.imp, y, { ...o, align: 'right' });
    y -= 20;
  };
  encTabla();

  // Agrupa por categoría, conservando el orden en que aparecen
  const grupos = [];
  for (const p of calc.partidas) {
    const g = p.categoria || '';
    let gr = grupos.find((x) => x.cat === g);
    if (!gr) grupos.push(gr = { cat: g, items: [] });
    gr.items.push(p);
  }
  const salto = (necesita, tabla = true) => { if (y - necesita < 70) { encabezado(false); if (tabla) encTabla(); } };
  for (const g of grupos) {
    if (g.cat && grupos.length > 1) {
      salto(30);
      texto(g.cat, C.desc, y, { f: FB, size: 7.5, color: VERDE });
      y -= 13;
    }
    for (const p of g.items) {
      const lineas = renglones(p.descripcion || '-', 238, F, 8.5);
      const alto = lineas.length * 11 + 6;
      salto(alto);
      lineas.forEach((l, i) => texto(l, C.desc, y - i * 11, { size: 8.5 }));
      const conPrecio = !(p.tipo === 'formula');
      texto(conPrecio ? cant(p.cantidad) : '', C.cant, y, { size: 8.5, align: 'right' });
      texto(p.unidad || '', C.uni, y, { size: 7.5, color: GRIS, maxW: 62 });
      texto(conPrecio ? dinero(p.precio) : '', C.pu, y, { size: 8.5, align: 'right' });
      texto(p.moneda, C.mon, y, { size: 7.5, color: GRIS });
      texto(p.iva ? `${cant(p.iva)}%` : '-', C.iva, y, { size: 7.5, color: GRIS });
      texto(dinero(p.importe), C.imp, y, { f: FB, size: 8.5, align: 'right' });
      y -= alto - 6;
      page.drawLine({ start: { x: M, y: y - 3 }, end: { x: W - M, y: y - 3 }, thickness: 0.5, color: LINEA });
      y -= 12;
    }
  }
  if (!calc.partidas.length) { texto('Sin partidas', C.desc, y, { color: GRIS }); y -= 16; }

  // ---- Totales ----
  const monedas = ['MXN', 'USD'].filter((m) => calc.partidas.some((p) => p.moneda === m));
  const altoTot = monedas.length * 46 + (calc.granMXN !== null && monedas.length > 1 ? 40 : 0) + 10;
  salto(altoTot, false);
  y -= 4;
  const xEt = W - M - 200, xVal = W - M - 6;
  for (const m of monedas) {
    const t = calc.totales[m];
    texto(`Subtotal ${m}`, xEt, y, { size: 8.5, color: GRIS }); texto(`$${dinero(t.subtotal)}`, xVal, y, { size: 8.5, align: 'right' }); y -= 12;
    texto(`IVA ${m}`, xEt, y, { size: 8.5, color: GRIS }); texto(`$${dinero(t.iva)}`, xVal, y, { size: 8.5, align: 'right' }); y -= 6;
    page.drawRectangle({ x: xEt - 6, y: y - 15, width: W - M - xEt + 6, height: 17, color: SUAVE });
    texto(`TOTAL ${m}`, xEt, y - 10, { f: FB, size: 9.5, color: AZUL }); texto(`$${dinero(t.total)}`, xVal, y - 10, { f: FB, size: 10, align: 'right', color: AZUL });
    y -= 28;
  }
  if (calc.granMXN !== null && monedas.length > 1) {
    texto(`Total equivalente (T.C. ${d.tc})`, xEt, y, { f: FB, size: 7.5, color: GRIS }); y -= 12;
    texto(`$${dinero(calc.granMXN)} MXN   ·   $${dinero(calc.granUSD)} USD`, xVal, y, { f: FB, size: 9, align: 'right', color: VERDE });
    y -= 18;
  }

  // ---- Notas y condiciones ----
  if (String(d.notas || '').trim()) {
    const lineas = renglones(d.notas, W - 2 * M - 10, F, 8);
    salto(Math.min(lineas.length, 6) * 10 + 24, false);
    y -= 6;
    texto('NOTAS Y CONDICIONES', M, y, { f: FB, size: 8, color: AZUL }); y -= 13;
    for (const l of lineas) { salto(12, false); texto(l, M, y, { size: 8, color: NEGRO }); y -= 10.5; }
  }
  if (d.elaboro) { if (y - 14 < 40) encabezado(false); y -= 14; texto(`Elaboró: ${d.elaboro}`, M, y, { size: 8.5, color: GRIS }); }

  pie();
  return Buffer.from(await pdf.save());
}

module.exports = { generarPDFCotizacion };

// Genera el PDF "Cotización de servicios" (hoja carta) con pdf-lib, sin plantilla.
// Secciones: 1) Detalles del embarque  2) Desglose de cargos  3) Impuestos aduanales  + total y notas.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const NAVY = hex('#0d1f3c');
const AZUL = hex('#1f4e8c');
const CIAN = hex('#2fa9d6');
const VERDE = hex('#0f8a6c');
const TINTA = hex('#15181d');
const GRIS = hex('#5d6672');
const GRIS2 = hex('#8a929c');
const LINEA = hex('#d9dee5');
const SUAVE = hex('#f3f6fa');
const SUAVE2 = hex('#e9eff7');
const BLANCO = rgb(1, 1, 1);
const CLARO = hex('#9fb0c8');
const ORO = hex('#ffc861');
const AMBAR = hex('#fdf6e7');
const ENC = hex('#dce7f5');        // encabezados de tabla (azul claro)
const ENC_BORDE = hex('#b9c9e0');
const AMBAR2 = hex('#e8a33d');

const TIPOS = { TERRESTRE: 'TERRESTRE', MARITIMA: 'MARÍTIMA', FFCC: 'FFCC' };
const OPER = { IMPORTACION: 'IMPORTACIÓN', EXPORTACION: 'EXPORTACIÓN' };
const CONT = {
  '20ST': "20' Estándar", '40ST': "40' Estándar", '40HC': "40' High Cube", '45HC': "45' High Cube", '20RF': "20' Refrigerado",
  '40RH': "40' Refrigerado HC", '20OT': "20' Open Top", '40OT': "40' Open Top", '20FR': "20' Flat Rack", '40FR': "40' Flat Rack",
  '20TK': "20' Tanque", LCL: 'Consolidado',
};
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

// Las fuentes estándar solo traen caracteres latinos; lo demás se cambia por "?"
const limpio = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/→/g, '->').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
const dinero = (x) => (Number(x) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaTxt = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]} ${MESES[Number(m[2]) - 1]} ${m[1]}` : ''; };
const vacio = (x) => String(x ?? '').trim() === '';

async function generarPDFCotizacion(reg, calc, folio) {
  const d = reg.datos;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Cotizacion de servicios ${folio}`);
  pdf.setAuthor('Grupo Meja');
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const FB = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null;
  try { logo = await pdf.embedPng(fs.readFileSync(path.join(__dirname, 'public', 'logo.png'))); } catch (_) {}

  const W = 612, H = 792, M = 36, ANCHO = W - 2 * M, PIE = 62;
  let page, y;

  const ancho = (s, f, size, esp = 0) => { const t = limpio(s); return f.widthOfTextAtSize(t, size) + esp * Math.max(t.length - 1, 0); };
  const texto = (s, x, yy, { f = F, size = 9, color = TINTA, align = 'left', maxW, espacio = 0 } = {}) => {
    let t = limpio(s);
    if (maxW && f.widthOfTextAtSize(t, size) > maxW) {
      while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
      t = `${t.trimEnd()}...`;
    }
    const w = f.widthOfTextAtSize(t, size) + espacio * Math.max(t.length - 1, 0);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(t, { x: xx, y: yy, size, font: f, color, ...(espacio ? { characterSpacing: espacio } : {}) });
  };
  const caja = (x, yy, w, h, color, borde) => page.drawRectangle({ x, y: yy, width: w, height: h, color, ...(borde ? { borderColor: borde, borderWidth: 0.6 } : {}) });
  const linea = (x1, y1, x2, y2, color = LINEA, grosor = 0.6) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: grosor, color });
  const renglones = (s, w, f = F, size = 9) => {
    const out = [];
    for (const parrafo of limpio(s).split('\n')) {
      let l = '';
      for (const pal of parrafo.split(/\s+/)) {
        const p = l ? `${l} ${pal}` : pal;
        if (f.widthOfTextAtSize(p, size) <= w) l = p; else { if (l) out.push(l); l = pal; }
      }
      out.push(l);
    }
    return out;
  };

  // ---------- Encabezado ----------
  const subt = [TIPOS[d.tipo], d.contenedor, d.modalidad].filter(Boolean).join('  |  ');
  function encabezado(primera) {
    page = pdf.addPage([W, H]);
    if (logo) {
      const h = primera ? 40 : 28, w = logo.width * (h / logo.height);
      page.drawImage(logo, { x: M, y: H - (primera ? 64 : 46), width: w, height: h });
    }
    if (primera) {
      texto('COTIZACIÓN DE SERVICIOS', W - M, H - 40, { f: FB, size: 16, color: NAVY, align: 'right', espacio: 0.6 });
      if (subt) {
        const tw = ancho(subt, FB, 7, 0.8) + 22;
        caja(W - M - tw, H - 62, tw, 15, AZUL);
        texto(subt, W - M - 11, H - 57.5, { f: FB, size: 7, color: BLANCO, align: 'right', espacio: 0.8 });
      }
      const ref = [`Folio ${folio}`, d.trafico && `Tráfico ${d.trafico}`, d.fecha && `Emitida: ${fechaTxt(d.fecha)}`].filter(Boolean).join('   |   ');
      texto(ref, W - M, H - 77, { size: 7.5, color: GRIS, align: 'right' });
      y = H - 90;
    } else {
      texto('COTIZACIÓN DE SERVICIOS', W - M, H - 32, { f: FB, size: 11, color: NAVY, align: 'right', espacio: 0.5 });
      texto(`${folio}  (continuación)`, W - M, H - 45, { size: 7.5, color: GRIS, align: 'right' });
      y = H - 60;
    }
    caja(0, y - 3, W, 3, AZUL);
    y -= 3;
    if (primera) {
      // Banda oscura: cliente / operación / vigencia
      const hB = 54;
      caja(0, y - hB, W, hB, NAVY);
      texto('COTIZACIÓN DIRIGIDA A', M, y - 19, { f: FB, size: 6.5, color: CLARO, espacio: 1.2 });
      texto(d.cliente || '-', M, y - 35, { f: FB, size: 12, color: BLANCO, maxW: 360 });
      linea(W - M - 150, y - 12, W - M - 150, y - hB + 12, hex('#2c3e5c'), 0.8);
      texto('OPERACIÓN', W - M, y - 19, { f: FB, size: 6.5, color: CLARO, align: 'right', espacio: 1.2 });
      texto(OPER[d.operacion] || '-', W - M, y - 35, { f: FB, size: 12, color: BLANCO, align: 'right' });
      if (d.valido_hasta) texto(`Válida hasta ${fechaTxt(d.valido_hasta)}`, W - M, y - 46, { size: 7, color: CLARO, align: 'right' });
      y -= hB + 24;
    } else y -= 24;
  }
  const espacio = (h) => { if (y - h < PIE) encabezado(false); };
  const titulo = (t) => {
    espacio(46);
    texto(t, M, y, { f: FB, size: 7.5, color: AZUL, espacio: 1.6 });
    linea(M + ancho(t, FB, 7.5, 1.6) + 10, y + 3, W - M, y + 3, LINEA, 0.8);
    y -= 16;
  };
  // Cuadrícula de datos (etiqueta pequeña + valor), primera columna sombreada como en el formato de referencia.
  // Si un valor es largo, primero se reduce la letra y solo al final se recorta.
  const cuadricula = (items, cols, rh, colorValor) => {
    const cw = ANCHO / cols, filas = Math.ceil(items.length / cols);
    espacio(filas * rh + 10);
    caja(M, y - filas * rh, ANCHO, filas * rh, BLANCO, LINEA);
    items.forEach(([k, v], i) => {
      const c = i % cols, r = Math.floor(i / cols), x = M + c * cw, yy = y - r * rh;
      if (c === 0) caja(x + 0.6, yy - rh + 0.6, cw - 0.6, rh - 1.2, SUAVE);
      if (c > 0) linea(x, yy, x, yy - rh);
      if (r > 0) linea(M, yy, W - M, yy);
      texto(k, x + 10, yy - 11, { f: FB, size: 6, color: GRIS, espacio: 0.8 });
      let size = 8.5;
      while (size > 6.5 && !vacio(v) && ancho(v, FB, size) > cw - 18) size -= 0.5;
      texto(vacio(v) ? '-' : v, x + 10, yy - 23, { f: FB, size, color: vacio(v) ? GRIS2 : colorValor, maxW: cw - 18 });
    });
    y -= filas * rh + 24;
  };
  // Encabezado de tabla: fondo azul claro, letras azul marino y títulos centrados en su columna
  const encTabla = (cols) => {
    caja(M, y - 14, ANCHO, 20, ENC, ENC_BORDE);
    for (const [t, x1, x2] of cols) texto(t, (x1 + x2) / 2, y - 7, { f: FB, size: 6.5, color: NAVY, align: 'center', espacio: 1 });
    for (const [, x1] of cols.slice(1)) linea(x1, y + 6, x1, y - 14, ENC_BORDE);
    y -= 14;
  };
  const centro = (x1, x2) => (x1 + x2) / 2;

  encabezado(true);

  // ---------- 1. Detalles del embarque ----------
  titulo('DETALLES DEL EMBARQUE');
  const proveedor = d.proveedor ?? (d.impuestos || {}).proveedor, buque = d.buque_eta ?? (d.impuestos || {}).buque_eta;
  const contenedores = d.contenedores ?? (d.impuestos || {}).contenedores;
  cuadricula([
    ['TIPO DE COTIZACIÓN', TIPOS[d.tipo]], ['TIPO DE OPERACIÓN', OPER[d.operacion]], ['TRÁFICO', d.trafico],
    ['NAVIERA', d.naviera], ['MODALIDAD', d.modalidad], ['TIPO DE CONTENEDOR', d.contenedor ? `${d.contenedor}${CONT[d.contenedor] ? ` - ${CONT[d.contenedor]}` : ''}` : ''],
    ['PROVEEDOR', proveedor], ['BUQUE / E.T.A.', buque], ['CONTENEDOR(ES)', contenedores],
    ['FECHA', fechaTxt(d.fecha)], ['VÁLIDO HASTA', fechaTxt(d.valido_hasta)], ['TIPO DE CAMBIO', d.tc ? `$${d.tc} MXN por USD` : ''],
  ], 3, 32, AZUL);

  // ---------- 2. Desglose de cargos ----------
  titulo('DESGLOSE DE CARGOS');
  const C1 = M, C2 = M + 190, C3 = W - M - 130, C4 = W - M;   // límites de columnas: concepto | descripción | costo
  const colsCargos = [['CONCEPTO', C1, C2], ['DESCRIPCIÓN', C2, C3], ['COSTO', C3, C4]];
  espacio(70); encTabla(colsCargos);
  const grupos = [['USD', 'CARGOS EN DÓLARES (USD)'], ['MXN', 'CARGOS EN PESOS (MXN)']];
  for (const [mon, etiqueta] of grupos) {
    const items = calc.partidas.filter((p) => p.moneda === mon);
    if (!items.length) continue;
    if (y - 45 < PIE) { encabezado(false); encTabla(colsCargos); }
    caja(M, y - 15, ANCHO, 15, SUAVE2);
    texto(etiqueta, centro(C1, C4), y - 10.5, { f: FB, size: 6.5, color: AZUL, align: 'center', espacio: 1.2 });
    y -= 15;
    for (const p of items) {
      const ld = renglones(p.descripcion || '', C3 - C2 - 16, F, 8);
      const lc = renglones(p.concepto || '-', C2 - C1 - 16, FB, 8.5);
      const n = Math.max(ld.length, lc.length), h = 12 + n * 10.5;
      if (y - h < PIE) { encabezado(false); encTabla(colsCargos); }
      const arriba = (k) => y - 14 - ((n - k) * 10.5) / 2;   // centra verticalmente columnas con menos renglones
      lc.forEach((l, i) => texto(l, centro(C1, C2), arriba(lc.length) - i * 10.5, { f: FB, size: 8.5, align: 'center' }));
      ld.forEach((l, i) => texto(l, centro(C2, C3), arriba(ld.length) - i * 10.5, { size: 8, color: GRIS, align: 'center' }));
      texto(`$ ${dinero(p.monto)}`, centro(C3, C4), arriba(1), { f: FB, size: 9, color: mon === 'USD' ? AZUL : VERDE, align: 'center' });
      linea(C2, y, C2, y - h); linea(C3, y, C3, y - h);
      y -= h;
      linea(M, y, W - M, y);
    }
  }
  if (!calc.partidas.length) { texto('Sin cargos', centro(C1, C4), y - 14, { color: GRIS, align: 'center' }); y -= 22; }
  const subs = grupos.filter(([m]) => calc.partidas.some((p) => p.moneda === m));
  if (subs.length) {
    espacio(subs.length * 20 + 10);
    y -= 8;
    const xb = W - M - 230;
    for (const [m] of subs) {
      caja(xb, y - 18, 230, 18, SUAVE);
      texto(`Subtotal ${m}`, xb + 10, y - 12, { size: 8, color: GRIS });
      texto(`${m} $ ${dinero(calc.cargos[m])}`, W - M - 10, y - 12, { f: FB, size: 9, align: 'right' });
      y -= 20;
    }
  }
  y -= 22;

  // ---------- 3. Impuestos aduanales ----------
  const im = d.impuestos || {}, ci = calc.impuestos;
  const hayImp = ['factura', 'valor_usd', 'igi', 'dta', 'iva', 'valor_aduana'].some((k) => !vacio(im[k]));
  if (hayImp) {
    espacio(250); // la sección completa va en la misma página
    titulo('IMPUESTOS ADUANALES');
    cuadricula([['FACTURA', im.factura], ['TIPO DE CAMBIO APROX.', ci.tc ? `$ ${ci.tc} MXN por USD` : ''],
      ['MERCANCÍA', im.mercancia], ['RÉGIMEN / FRACCIÓN ARANCELARIA', im.regimen]], 2, 30, TINTA);
    y += 10;
    const izq = [
      ['Valor en dólares', ci.valorUsd ? `USD $ ${dinero(ci.valorUsd)}` : '-'],
      ['Incrementables', ci.incrementables ? `$ ${dinero(ci.incrementables)}` : '-'],
      ['Valor aduana', ci.valorAduana ? `$ ${dinero(ci.valorAduana)}` : '-'],
    ];
    const der = [['I.G.I. / Ad Valorem', ci.igi], ['D.T.A.', ci.dta], ['I.V.A.', ci.iva], ['Prevalidación', ci.prevalidacion], ['Contraprestación', ci.contraprestacion]]
      .map(([k, v]) => [k, `$ ${dinero(v)}`]);
    const mitad = M + ANCHO / 2, q1 = M + ANCHO / 4, q3 = M + (3 * ANCHO) / 4, filasM = Math.max(izq.length, der.length), rh = 17;
    espacio(20 + filasM * rh + 34);
    encTabla([['BASE GRAVABLE', M, q1], ['MONTO', q1, mitad], ['IMPUESTO', mitad, q3], ['COSTO (MXN)', q3, W - M]]);
    for (let i = 0; i < filasM; i++) {
      const yy = y - i * rh;
      if (izq[i]) { texto(izq[i][0], centro(M, q1), yy - 12, { size: 8.5, color: GRIS, align: 'center' }); texto(izq[i][1], centro(q1, mitad), yy - 12, { f: FB, size: 8.5, align: 'center' }); }
      if (der[i]) { texto(der[i][0], centro(mitad, q3), yy - 12, { size: 8.5, color: GRIS, align: 'center' }); texto(der[i][1], centro(q3, W - M), yy - 12, { f: FB, size: 8.5, align: 'center' }); }
      linea(M, yy - rh, W - M, yy - rh);
    }
    for (const x of [q1, mitad, q3]) linea(x, y, x, y - filasM * rh, x === mitad ? hex('#b9c6d8') : LINEA);
    y -= filasM * rh + 6;
    caja(mitad, y - 24, ANCHO / 2, 24, NAVY);
    texto('TOTAL IMPUESTOS', mitad + 10, y - 15, { f: FB, size: 7, color: CLARO, espacio: 1.2 });
    texto(`MXN $ ${dinero(ci.total)}`, W - M - 10, y - 16, { f: FB, size: 11, color: ORO, align: 'right' });
    y -= 46;
  }

  // ---------- Total estimado ----------
  const resumen = [];
  if (calc.cargos.USD) resumen.push(['Desglose de cargos (USD)', `USD $ ${dinero(calc.cargos.USD)}`]);
  if (calc.cargos.MXN) resumen.push(['Desglose de cargos (MXN)', `MXN $ ${dinero(calc.cargos.MXN)}`]);
  if (hayImp) resumen.push(['Impuestos aduanales', `MXN $ ${dinero(ci.total)}`]);
  const totLin = [calc.totalUSD ? `USD $ ${dinero(calc.totalUSD)}` : '', calc.totalMXN ? `MXN $ ${dinero(calc.totalMXN)}` : ''].filter(Boolean);
  if (resumen.length && totLin.length) {
    const equiv = calc.granMXN !== null && calc.totalUSD && calc.totalMXN;
    const hT = 18 + totLin.length * 19 + (equiv ? 14 : 0);
    espacio(resumen.length * 18 + hT + 14);
    const xb = W - M - 270;
    for (const [k, v] of resumen) {
      texto(k, xb + 10, y - 12, { size: 8.5, color: GRIS });
      texto(v, W - M - 10, y - 12, { f: FB, size: 8.5, align: 'right' });
      linea(xb, y - 18, W - M, y - 18);
      y -= 18;
    }
    y -= 8;
    caja(xb, y - hT, 270, hT, NAVY);
    texto('TOTAL ESTIMADO', xb + 12, y - 20, { f: FB, size: 7, color: CLARO, espacio: 1.4 });
    totLin.forEach((t, i) => texto(t, W - M - 12, y - 22 - i * 19, { f: FB, size: 14, color: ORO, align: 'right' }));
    if (equiv) texto(`Equivalente (T.C. ${d.tc}): MXN $ ${dinero(calc.granMXN)}  |  USD $ ${dinero(calc.granUSD)}`, W - M - 12, y - hT + 8, { size: 6.5, color: hex('#c7d2e2'), align: 'right' });
    y -= hT + 26;
  }

  // ---------- Notas y condiciones ----------
  if (!vacio(d.notas)) {
    const lineas = renglones(d.notas, ANCHO - 44, F, 8).filter((l) => l.trim());
    espacio(Math.min(30 + lineas.length * 11, 130) + 16);
    titulo('NOTAS Y CONDICIONES');
    const hb = Math.min(28 + lineas.length * 11, y - PIE);
    caja(M, y - hb + 6, ANCHO, hb, AMBAR);
    caja(M, y - hb + 6, 2.5, hb, AMBAR2);
    texto('IMPORTANTE', M + 14, y - 8, { f: FB, size: 6.5, color: hex('#b7791f'), espacio: 1.2 });
    y -= 24;
    for (const l of lineas) {
      if (y - 11 < PIE) encabezado(false);
      page.drawCircle({ x: M + 17, y: y + 2.6, size: 1.3, color: TINTA });
      texto(l, M + 24, y, { size: 8 });
      y -= 11;
    }
  }

  // ---------- Pie en todas las páginas ----------
  const pags = pdf.getPages();
  pags.forEach((p, i) => {
    page = p;
    caja(0, 0, W, 44, NAVY);
    caja(0, 44, W, 2.5, CIAN);
    texto('Grupo Meja', M, 27, { f: FB, size: 9, color: BLANCO });
    texto('A.A. Gonzalez Castillo & Medina S.C.  ·  Av. Reynosa #2047, Col. Guerrero, Nuevo Laredo, Tamps.  ·  Tel. (867) 715-45-38', M, 15, { size: 6.5, color: CLARO });
    texto(folio, W - M, 27, { f: FB, size: 8, color: BLANCO, align: 'right' });
    texto(`Página ${i + 1} de ${pags.length}`, W - M, 15, { size: 6.5, color: CLARO, align: 'right' });
  });
  return Buffer.from(await pdf.save());
}

module.exports = { generarPDFCotizacion };

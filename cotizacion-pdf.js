// Genera el PDF "Cotización de servicios" en UNA hoja carta, compacto y a todo lo ancho (pdf-lib, sin plantilla).
// Secciones: Detalles del embarque · Desglose de cargos · Impuestos aduanales · Notas y total estimado.
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
const LINEA = hex('#dde2e9');
const SUAVE = hex('#f3f6fa');
const SUAVE2 = hex('#eaf0f8');
const ENC = hex('#dce7f5');        // encabezados de tabla (azul claro)
const ENC_BORDE = hex('#b9c9e0');
const BLANCO = rgb(1, 1, 1);
const CLARO = hex('#9fb0c8');
const ORO = hex('#ffc861');
const AMBAR = hex('#fdf6e7');
const NARANJA = hex('#f26a0f');   // títulos de sección (naranja MEJAnet)
const AMBAR2 = hex('#e8a33d');

const TIPOS = { TERRESTRE: 'TERRESTRE', MARITIMA: 'MARÍTIMA', FFCC: 'FFCC (FERROCARRIL)' };
const OPER = { IMPORTACION: 'IMPORTACIÓN', EXPORTACION: 'EXPORTACIÓN' };
const CONT = {
  '20ST': "20' Estándar", '40ST': "40' Estándar", '40HC': "40' High Cube", '45HC': "45' High Cube", '20RF': "20' Refrigerado",
  '40RH': "40' Refrigerado HC", '20OT': "20' Open Top", '40OT': "40' Open Top", '20FR': "20' Flat Rack", '40FR': "40' Flat Rack",
  '20TK': "20' Tanque", LCL: 'Consolidado',
};
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

// Las fuentes estándar solo traen caracteres latinos; lo demás se cambia por "?"
const limpio = (s) => String(s ?? '').toUpperCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
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
  try { logo = await pdf.embedPng(fs.readFileSync(path.join(__dirname, 'public', 'logo-color.png'))); } catch (_) {}

  const W = 612, H = 792, M = 22, ANCHO = W - 2 * M, PIE = 34;
  let page, y;

  const ancho = (s, f, size, esp = 0) => { const t = limpio(s); return f.widthOfTextAtSize(t, size) + esp * Math.max(t.length - 1, 0); };
  const texto = (s, x, yy, { f = F, size = 7.5, color = TINTA, align = 'left', maxW, espacio = 0 } = {}) => {
    let t = limpio(s);
    if (maxW && f.widthOfTextAtSize(t, size) > maxW) {
      while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
      t = `${t.trimEnd()}...`;
    }
    const w = f.widthOfTextAtSize(t, size) + espacio * Math.max(t.length - 1, 0);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    if (!espacio) { page.drawText(t, { x: xx, y: yy, size, font: f, color }); return; }
    let cx = xx;
    for (const ch of t) { page.drawText(ch, { x: cx, y: yy, size, font: f, color }); cx += f.widthOfTextAtSize(ch, size) + espacio; }
  };
  const caja = (x, yy, w, h, color, borde) => page.drawRectangle({ x, y: yy, width: w, height: h, color, ...(borde ? { borderColor: borde, borderWidth: 0.5 } : {}) });
  const linea = (x1, y1, x2, y2, color = LINEA, grosor = 0.5) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: grosor, color });
  const renglones = (s, w, f = F, size = 7.5) => {
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
  const centro = (a, b) => (a + b) / 2;

  // ---------- Encabezado ----------
  const subt = [TIPOS[d.tipo], d.contenedor, d.modalidad].filter(Boolean).join('  |  ');
  function encabezado(primera) {
    page = pdf.addPage([W, H]);
    y = H - 14;
    if (logo) {
      const h = primera ? 30 : 22, w = logo.width * (h / logo.height);
      page.drawImage(logo, { x: M, y: y - h, width: w, height: h });
    }
    texto('COTIZACIÓN DE SERVICIOS', W - M, y - 13, { f: FB, size: primera ? 14 : 10, color: NAVY, align: 'right', espacio: 0.5 });
    if (primera) {
      const ref = [`Folio ${folio}`, d.trafico && `Tráfico ${d.trafico}`, d.fecha && `Emitida: ${fechaTxt(d.fecha)}`].filter(Boolean).join('   |   ');
      let xr = W - M;
      if (subt) {
        const tw = ancho(subt, FB, 6.5, 0.7) + 16;
        caja(W - M - tw, y - 29, tw, 12, AZUL);
        texto(subt, W - M - tw / 2, y - 25.3, { f: FB, size: 6.5, color: BLANCO, align: 'center', espacio: 0.7 });
        xr = W - M - tw - 10;
      }
      texto(ref, xr, y - 25, { size: 6.5, color: GRIS, align: 'right' });
      y -= 36;
    } else { texto(`${folio} (continuación)`, W - M, y - 23, { size: 6.5, color: GRIS, align: 'right' }); y -= 28; }
    caja(0, y - 2, W, 2, AZUL);
    y -= 2;
    if (primera) {
      const hB = 30;
      caja(0, y - hB, W, hB, NAVY);
      texto('COTIZACIÓN DIRIGIDA A', M, y - 11, { f: FB, size: 5.5, color: CLARO, espacio: 1 });
      texto(d.cliente || '-', M, y - 23, { f: FB, size: 10, color: BLANCO, maxW: W - 2 * M - 220 });
      texto('OPERACIÓN', W - M - 200, y - 11, { f: FB, size: 5.5, color: CLARO, espacio: 1 });
      texto(OPER[d.operacion] || '-', W - M - 200, y - 23, { f: FB, size: 10, color: BLANCO });
      texto('VÁLIDA HASTA', W - M, y - 11, { f: FB, size: 5.5, color: CLARO, align: 'right', espacio: 1 });
      texto(fechaTxt(d.valido_hasta) || '-', W - M, y - 23, { f: FB, size: 10, color: BLANCO, align: 'right' });
      y -= hB + 22;
    } else y -= 16;
  }
  const espacio = (h) => { if (y - h < PIE) encabezado(false); };
  const titulo = (t) => {
    espacio(36);
    texto(t, M, y, { f: FB, size: 8, color: NARANJA, espacio: 2.4 });
    linea(M + ancho(t, FB, 8, 2.4) + 12, y + 3, W - M, y + 3, LINEA, 0.7);
    y -= 9;
  };
  // Cuadrícula de datos (etiqueta pequeña + valor); una celda puede ocupar varias columnas ([etiqueta, valor, columnas]).
  // Primera columna sombreada; si un valor es largo se achica la letra.
  const cuadricula = (items, cols, rh, colorValor) => {
    const cw = ANCHO / cols, pos = [];
    let c = 0, r = 0;
    for (const [k, v, n = 1] of items) { if (c + n > cols) { c = 0; r++; } pos.push({ k, v, c, r, n }); c += n; }
    const filas = r + 1;
    espacio(filas * rh + 6);
    caja(M, y - filas * rh, ANCHO, filas * rh, BLANCO, LINEA);
    for (const { k, v, c: cc, r: rr, n } of pos) {
      const x = M + cc * cw, yy = y - rr * rh, w = cw * n;
      if (cc === 0) caja(x + 0.5, yy - rh + 0.5, w - 0.5, rh - 1, SUAVE);
      if (cc > 0) linea(x, yy, x, yy - rh);
      if (rr > 0) linea(M, yy, W - M, yy);
      texto(k, x + 7, yy - 9, { f: FB, size: 5.8, color: GRIS, espacio: 0.6 });
      let size = 8.5;
      while (size > 6.5 && !vacio(v) && ancho(v, FB, size) > w - 12) size -= 0.25;
      texto(vacio(v) ? '-' : v, x + 7, yy - 20, { f: FB, size, color: vacio(v) ? GRIS2 : colorValor, maxW: w - 12 });
    }
    y -= filas * rh + 22;
  };
  // Encabezado de tabla: azul claro, títulos centrados en su columna
  const encTabla = (cols) => {
    caja(M, y - 15, ANCHO, 15, ENC, ENC_BORDE);
    for (const [t, x1, x2] of cols) texto(t, centro(x1, x2), y - 10.3, { f: FB, size: 6.8, color: NAVY, align: 'center', espacio: 0.9 });
    for (const [, x1] of cols.slice(1)) linea(x1, y, x1, y - 15, ENC_BORDE);
    y -= 15;
  };

  encabezado(true);

  // ---------- 1. Detalles del embarque ----------
  titulo('DETALLES DEL EMBARQUE');
  const ter = d.tipo === 'TERRESTRE';   // naviera y buque no aplican
  cuadricula([
    ['TIPO DE COTIZACIÓN', TIPOS[d.tipo]], ['TIPO DE OPERACIÓN', OPER[d.operacion]], ['TRÁFICO', d.trafico], ['NAVIERA', ter ? 'N/A' : d.naviera],
    ['MODALIDAD', d.modalidad], ['TIPO DE CONTENEDOR', d.contenedor ? `${d.contenedor}${CONT[d.contenedor] ? ` - ${CONT[d.contenedor]}` : ''}` : ''],
    ['BUQUE / E.T.A.', ter ? 'N/A' : d.buque_eta], ['FECHA', fechaTxt(d.fecha)],
    ['PROVEEDOR', d.proveedor, 3], ['TIPO DE CAMBIO', d.tc ? `$${d.tc} MXN por USD` : ''],
  ], 4, 26, AZUL);

  // ---------- 2. Desglose de cargos ----------
  titulo('DESGLOSE DE CARGOS');
  const C1 = M, C2 = M + 190, C3 = W - M - 110, C4 = W - M;   // concepto | descripción | costo
  const colsCargos = [['CONCEPTO', C1, C2], ['DESCRIPCIÓN', C2, C3], ['COSTO', C3, C4]];
  espacio(50); encTabla(colsCargos);
  const grupos = [['USD', 'CARGOS EN DÓLARES (USD)'], ['MXN', 'CARGOS EN PESOS (MXN)']];
  const LH = 9;
  for (const [mon, etiqueta] of grupos) {
    const items = calc.partidas.filter((p) => p.moneda === mon);
    if (!items.length) continue;
    if (y - 30 < PIE) { encabezado(false); encTabla(colsCargos); }
    caja(M, y - 13, ANCHO, 13, SUAVE2);
    texto(etiqueta, centro(C2, C3), y - 9.3, { f: FB, size: 7, color: AZUL, align: 'center', espacio: 1.1 });
    y -= 13;
    for (const p of items) {
      const lc = renglones(p.concepto || '-', C2 - C1 - 12, F, 7.3);
      const ld = renglones(p.descripcion || '', C3 - C2 - 12, F, 7);
      const n = Math.max(lc.length, ld.length), h = 7 + n * LH;
      if (y - h < PIE) { encabezado(false); encTabla(colsCargos); }
      const base = (k) => y - 10.2 - ((n - k) * LH) / 2;   // centra verticalmente columnas con menos renglones
      lc.forEach((l, i) => texto(l, centro(C1, C2), base(lc.length) - i * LH, { size: 7.3, color: GRIS, align: 'center' }));
      ld.forEach((l, i) => texto(l, centro(C2, C3), base(ld.length) - i * LH, { size: 7, color: GRIS, align: 'center' }));
      texto(`$ ${dinero(p.monto)}`, C4 - 8, base(1), { f: FB, size: 8.3, color: mon === 'USD' ? AZUL : VERDE, align: 'right' });
      linea(C2, y, C2, y - h); linea(C3, y, C3, y - h);
      y -= h;
      linea(M, y, W - M, y);
    }
  }
  if (!calc.partidas.length) { texto('Sin cargos', centro(C1, C4), y - 9, { color: GRIS, align: 'center' }); y -= 14; }
  // Subtotales en una sola franja, alineados a la derecha
  const subs = grupos.filter(([m]) => calc.partidas.some((p) => p.moneda === m));
  if (subs.length) {
    espacio(16);
    y -= 3;
    const anchoSub = 165, x0 = W - M - anchoSub * subs.length - 4 * (subs.length - 1);
    subs.forEach(([m], i) => {
      const x = x0 + i * (anchoSub + 4);
      caja(x, y - 14, anchoSub, 14, SUAVE);
      texto(`Subtotal ${m}`, x + 7, y - 9.8, { size: 7.2, color: GRIS });
      texto(`${m} $ ${dinero(calc.cargos[m])}`, x + anchoSub - 7, y - 9.8, { f: FB, size: 8.3, align: 'right' });
    });
    y -= 14;
  }
  y -= 26;

  // ---------- 3. Impuestos aduanales ----------
  const im = d.impuestos || {}, ci = calc.impuestos;
  const hayImp = ['factura', 'valor_usd', 'igi', 'dta', 'iva', 'valor_aduana'].some((k) => !vacio(im[k]));
  if (hayImp) {
    espacio(150); // la sección completa va junta
    titulo('IMPUESTOS ADUANALES');
    cuadricula([['FACTURA', im.factura], ['TIPO DE CAMBIO APROX.', ci.tc ? `$ ${ci.tc} MXN por USD` : ''],
      ['MERCANCÍA', im.mercancia, 2], ['RÉGIMEN ADUANERO', im.regimen, 4]], 4, 26, TINTA);
    y += 6;
    const izq = [
      ['Valor en dólares', ci.valorUsd ? `USD $ ${dinero(ci.valorUsd)}` : '-'],
      [ci.incrInformativo ? 'Incrementables (informativo)' : 'Incrementables', ci.incrementables ? `$ ${dinero(ci.incrementables)}` : '-'],
      ['Valor aduana', ci.valorAduana ? `$ ${dinero(ci.valorAduana)}` : '-'],
    ];
    const der = [['I.G.I. / Ad Valorem', ci.igi], ['D.T.A.', ci.dta], ['I.V.A.', ci.iva], ['Prevalidación', ci.prevalidacion], ['Contraprestación', ci.contraprestacion]]
      .map(([k, v]) => [k, `$ ${dinero(v)}`]);
    const mitad = M + ANCHO / 2, q1 = M + ANCHO / 4, q3 = M + (3 * ANCHO) / 4, filasM = Math.max(izq.length, der.length), rh = 13;
    encTabla([['BASE GRAVABLE', M, q1], ['MONTO', q1, mitad], ['IMPUESTO', mitad, q3], ['COSTO (MXN)', q3, W - M]]);
    for (let i = 0; i < filasM; i++) {
      const yy = y - i * rh;
      if (izq[i]) { texto(izq[i][0], centro(M, q1), yy - 9.4, { size: 7.8, color: GRIS, align: 'center' }); texto(izq[i][1], mitad - 8, yy - 9.4, { f: FB, size: 7.8, align: 'right' }); }
      if (der[i]) { texto(der[i][0], centro(mitad, q3), yy - 9.4, { size: 7.8, color: GRIS, align: 'center' }); texto(der[i][1], W - M - 8, yy - 9.4, { f: FB, size: 7.8, align: 'right' }); }
      linea(M, yy - rh, W - M, yy - rh);
    }
    for (const x of [q1, mitad, q3]) linea(x, y, x, y - filasM * rh, x === mitad ? ENC_BORDE : LINEA);
    y -= filasM * rh;
    caja(mitad, y - 17, ANCHO / 2, 17, NAVY);
    texto('TOTAL IMPUESTOS ADUANALES', mitad + 8, y - 11.3, { f: FB, size: 6.6, color: CLARO, espacio: 1 });
    texto(`MXN $ ${dinero(ci.total)}`, W - M - 8, y - 12, { f: FB, size: 10, color: ORO, align: 'right' });
    y -= 40;
  }

  // ---------- Notas (izquierda) y total estimado (derecha) ----------
  const resumen = [];
  if (calc.cargos.USD) resumen.push(['Desglose de cargos (USD)', `USD $ ${dinero(calc.cargos.USD)}`]);
  if (calc.cargos.MXN) resumen.push(['Desglose de cargos (MXN)', `MXN $ ${dinero(calc.cargos.MXN)}`]);
  if (hayImp) resumen.push(['Impuestos aduanales', `MXN $ ${dinero(ci.total)}`]);
  const totLin = [calc.totalUSD ? `USD $ ${dinero(calc.totalUSD)}` : '', calc.totalMXN ? `MXN $ ${dinero(calc.totalMXN)}` : ''].filter(Boolean);
  const equiv = calc.granMXN !== null && calc.totalUSD && calc.totalMXN;
  const anchoTot = 250, xT = W - M - anchoTot;
  const hTotal = totLin.length ? resumen.length * 13 + 4 + 14 + totLin.length * 16 + (equiv ? 11 : 0) + 4 : 0;
  const notas = vacio(d.notas) ? [] : renglones(d.notas, xT - M - 40, F, 7.5).filter((l) => l.trim());
  const hNotas = notas.length ? 20 + notas.length * 10.5 : 0;
  const hBloque = Math.max(hTotal, hNotas);
  if (hBloque) {
    espacio(hBloque + 10);
    titulo(notas.length ? 'NOTAS Y CONDICIONES' : 'TOTAL ESTIMADO');
    const y0 = y;
    if (notas.length) {
      caja(M, y0 - hNotas, xT - M - 12, hNotas, AMBAR);
      caja(M, y0 - hNotas, 2, hNotas, AMBAR2);
      texto('IMPORTANTE', M + 10, y0 - 10, { f: FB, size: 6.3, color: hex('#b7791f'), espacio: 1 });
      notas.forEach((l, i) => {
        page.drawCircle({ x: M + 12, y: y0 - 20 - i * 10.5 + 2.5, size: 1.1, color: TINTA });
        texto(l, M + 18, y0 - 20 - i * 10.5, { size: 7.5 });
      });
    }
    if (totLin.length) {
      let yy = y0;
      for (const [k, v] of resumen) {
        texto(k, xT + 8, yy - 9.5, { size: 7.5, color: GRIS });
        texto(v, W - M - 8, yy - 9.5, { f: FB, size: 7.8, align: 'right' });
        linea(xT, yy - 13, W - M, yy - 13);
        yy -= 13;
      }
      yy -= 4;
      const hT = 14 + totLin.length * 16 + (equiv ? 11 : 0);
      caja(xT, yy - hT, anchoTot, hT, NAVY);
      texto('TOTAL ESTIMADO', xT + 8, yy - 12, { f: FB, size: 6.6, color: CLARO, espacio: 1.2 });
      totLin.forEach((t, i) => texto(t, W - M - 8, yy - 15 - i * 16, { f: FB, size: 12.5, color: ORO, align: 'right' }));
      if (equiv) texto(`Equivalente (T.C. ${d.tc}): MXN $ ${dinero(calc.granMXN)} | USD $ ${dinero(calc.granUSD)}`, W - M - 8, yy - hT + 5, { size: 6, color: hex('#c7d2e2'), align: 'right' });
    }
    y = y0 - hBloque - 8;
  }

  // ---------- Pie en todas las páginas ----------
  const pags = pdf.getPages();
  pags.forEach((p, i) => {
    page = p;
    caja(0, 0, W, 24, NAVY);
    caja(0, 24, W, 1.5, CIAN);
    texto('Grupo Meja', M, 9, { f: FB, size: 7, color: BLANCO });
    texto('A.A. Gonzalez Castillo & Medina S.C.  ·  Av. Reynosa #2047, Col. Guerrero, Nuevo Laredo, Tamps.  ·  Tel. (867) 715-45-38', W / 2, 9.3, { size: 5.8, color: CLARO, align: 'center' });
    texto(`${folio}   ·   Página ${i + 1} de ${pags.length}`, W - M, 9, { f: FB, size: 6, color: BLANCO, align: 'right' });
  });
  return Buffer.from(await pdf.save());
}

module.exports = { generarPDFCotizacion };

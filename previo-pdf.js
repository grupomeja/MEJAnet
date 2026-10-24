// OP Manzanillo: «Reporte de previo» (revisión de mercancía) en hoja carta vertical (pdf-lib, sin plantilla).
// Secciones: 1) Revisión de mercancía (cliente, fecha, tráfico, factura y logo)
//            2) Información del contenedor   3) Partidas
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ---------- Datos ----------
const CAMPOS = ['cliente', 'fecha', 'trafico', 'factura', 'buque', 'contenedor', 'tipoCont', 'sello', 'operadora', 'claveCR',
  'bultos', 'peso', 'pallets', 'palletsCant'];
const PARTIDA = ['desc', 'marca', 'modelo', 'origen', 'pzsCarton', 'mercancia', 'cant'];
const TIPOS_CONT = { '20DC': "20' DC", '40DC': "40' DC", '40HC': "40' HC", SUELTA: 'Carga suelta' };
const PALLETS = { MADERA: 'Madera', PLASTICO: 'Plástico', SIN: 'Sin pallets' };

const t = (v, max) => String(v ?? '').trim().slice(0, max);
function limpiarPrevio(b) {
  if (!b || typeof b !== 'object') return null;
  const o = {};
  for (const k of CAMPOS) if (k in b) o[k] = t(b[k], 300);
  if ('tipoCont' in o && !TIPOS_CONT[o.tipoCont]) o.tipoCont = '';
  if ('pallets' in o && !PALLETS[o.pallets]) o.pallets = '';
  if ('fecha' in o && !/^\d{4}-\d{2}-\d{2}$/.test(o.fecha)) o.fecha = '';
  if (Array.isArray(b.partidas)) {
    o.partidas = b.partidas.slice(0, 80).map((p) => {
      const q = {};
      for (const k of PARTIDA) q[k] = t(p && p[k], k === 'desc' ? 400 : 160);
      return q;
    });
  }
  return o;
}

// ---------- PDF ----------
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const TINTA = hex('#2B241B');
const CAFE = hex('#5E4E37');      // texto de títulos
const CAFE_OSC = hex('#4A3826');
const CAFE_ICO = hex('#8C7553');
const BEIGE = hex('#EAE1D3');      // barras de título
const BEIGE_SUAVE = hex('#FAF6EF');
const LINEA = hex('#D9CBB5');
const GUINDA = hex('#7A1C1C');
const GRIS = hex('#7A7266');
const BLANCO = rgb(1, 1, 1);

const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const fechaTxt = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DIAS[d.getUTCDay()]} ${m[3]} ${MESES[+m[2] - 1]} ${m[1]}`;
};
// Las fuentes estándar solo traen caracteres latinos (WinAnsi); lo demás se cambia por "?"
const limpio = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/\r/g, '').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');

async function generarPrevio(rep, ref) {
  const r = limpiarPrevio(rep) || {};
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Reporte de previo ${ref || ''}`.trim());
  pdf.setCreator('MEJAnet · OP Manzanillo');
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const FB = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null;
  try { logo = await pdf.embedPng(fs.readFileSync(path.join(__dirname, 'public', 'logo-previo.png'))); } catch { /* sin logo */ }

  const W = 612, H = 792, M = 34, AN = W - 2 * M;
  let pg = pdf.addPage([W, H]);
  let y = H - M;

  const txt = (s, x, yy, size, font = F, color = TINTA) => pg.drawText(limpio(s), { x, y: yy, size, font, color });
  const ancho = (s, size, font = F) => font.widthOfTextAtSize(limpio(s), size);
  // Corta un texto en renglones que quepan en «w»
  const partir = (s, size, w, font = F) => {
    const out = [];
    for (const parrafo of limpio(s).split('\n')) {
      let linea = '';
      for (const pal of parrafo.split(/\s+/).filter(Boolean)) {
        let p = pal;
        while (font.widthOfTextAtSize(p, size) > w) { // palabra más larga que la celda
          let i = p.length - 1; while (i > 1 && font.widthOfTextAtSize(p.slice(0, i), size) > w) i--;
          if (linea) { out.push(linea); linea = ''; }
          out.push(p.slice(0, i)); p = p.slice(i);
        }
        const prueba = linea ? linea + ' ' + p : p;
        if (font.widthOfTextAtSize(prueba, size) <= w) linea = prueba; else { if (linea) out.push(linea); linea = p; }
      }
      out.push(linea);
    }
    return out.length ? out : [''];
  };
  const barra = (titulo, yy) => {
    pg.drawRectangle({ x: M, y: yy - 18, width: AN, height: 18, color: BEIGE });
    pg.drawRectangle({ x: M, y: yy - 18, width: 3, height: 18, color: CAFE_ICO });
    txt(titulo, M + 10, yy - 12.5, 9.5, FB, CAFE);
    return yy - 18;
  };
  // Campo: etiqueta pequeña arriba, valor en negrita y línea abajo
  const campo = (etq, valor, x, yy, w, { tam = 10 } = {}) => {
    txt(etq.toUpperCase(), x, yy - 8, 6.8, FB, GRIS);
    const lin = partir(valor, tam, w - 2, FB).slice(0, 2);
    lin.forEach((l, i) => txt(l, x + 1, yy - 21 - i * (tam + 2), tam, FB, TINTA));
    const base = yy - 25 - (lin.length - 1) * (tam + 2);
    pg.drawLine({ start: { x, y: base }, end: { x: x + w, y: base }, thickness: 0.6, color: LINEA });
    return base;
  };
  const casilla = (x, yy, marcada) => {
    pg.drawRectangle({ x, y: yy, width: 9, height: 9, borderColor: CAFE_OSC, borderWidth: 0.9, color: marcada ? CAFE_OSC : BLANCO });
    if (marcada) {
      pg.drawLine({ start: { x: x + 2, y: yy + 4.6 }, end: { x: x + 3.9, y: yy + 2.4 }, thickness: 1.3, color: BLANCO });
      pg.drawLine({ start: { x: x + 3.9, y: yy + 2.4 }, end: { x: x + 7.3, y: yy + 7 }, thickness: 1.3, color: BLANCO });
    }
  };
  const opciones = (etq, mapa, elegido, x, yy, w) => {
    txt(etq.toUpperCase(), x, yy - 8, 6.8, FB, GRIS);
    let cx = x;
    for (const [k, nombre] of Object.entries(mapa)) {
      casilla(cx, yy - 23, elegido === k);
      txt(nombre, cx + 13, yy - 21.5, 9, elegido === k ? FB : F, TINTA);
      cx += 13 + ancho(nombre, 9, elegido === k ? FB : F) + 14;
    }
    pg.drawLine({ start: { x, y: yy - 27 }, end: { x: x + w, y: yy - 27 }, thickness: 0.6, color: LINEA });
    return yy - 27;
  };

  // ---------- 1. Revisión de mercancía ----------
  pg.drawRectangle({ x: M, y: y - 74, width: AN, height: 74, color: BEIGE_SUAVE, borderColor: LINEA, borderWidth: 0.8 });
  pg.drawRectangle({ x: M, y: y - 74, width: AN, height: 3, color: GUINDA });
  if (logo) {
    const lw = 150, lh = lw * logo.height / logo.width;
    pg.drawImage(logo, { x: M + 14, y: y - 37 - lh / 2, width: lw, height: lh });
  }
  const tit = 'REVISIÓN DE MERCANCÍA';
  txt(tit, M + AN - 14 - ancho(tit, 17, FB), y - 28, 17, FB, CAFE_OSC);
  const sub = 'Reporte de previo · Puerto de Manzanillo';
  txt(sub, M + AN - 14 - ancho(sub, 8.5), y - 41, 8.5, F, CAFE_ICO);
  const cli = limpio(r.cliente || '').toUpperCase();
  const cliLin = partir(cli, 11, 300, FB).slice(0, 2);
  cliLin.forEach((l, i) => txt(l, M + AN - 14 - ancho(l, 11, FB), y - 57 - i * 12, 11, FB, GUINDA));
  y -= 84;
  const c3 = (AN - 2 * 14) / 3;
  let b1 = campo('Fecha', fechaTxt(r.fecha), M, y, c3);
  let b2 = campo('Tráfico', r.trafico, M + c3 + 14, y, c3);
  let b3 = campo('Factura', r.factura, M + 2 * (c3 + 14), y, c3);
  y = Math.min(b1, b2, b3) - 14;

  // ---------- 2. Información del contenedor ----------
  y = barra('INFORMACIÓN DEL CONTENEDOR', y) - 8;
  const g = 14, c2 = (AN - g) / 2;
  b1 = campo('Buque / viaje', r.buque, M, y, c2);
  b2 = campo('Contenedor no.', r.contenedor, M + c2 + g, y, c2);
  y = Math.min(b1, b2) - 8;
  y = opciones('Tipo de contenedor', TIPOS_CONT, r.tipoCont, M, y, AN) - 8;
  const c4 = (AN - 3 * g) / 4;
  const fila4 = [['Sello', r.sello], ['Operadora', r.operadora], ['Clave CR', r.claveCR], ['Bultos', r.bultos]];
  y = Math.min(...fila4.map(([e, v], i) => campo(e, v, M + i * (c4 + g), y, c4))) - 8;
  b1 = campo('Peso (kg)', r.peso, M, y, c4);
  b2 = opciones('Pallets', PALLETS, r.pallets, M + c4 + g, y, 2 * c4 + g);
  b3 = campo('Cant. de pallets', r.palletsCant, M + 3 * (c4 + g), y, c4);
  y = Math.min(b1, b2, b3) - 14;

  // ---------- 3. Partidas (cuadrantes: 4 por hoja, con renglones para escribir a mano) ----------
  const filas = (r.partidas || []).filter((p) => PARTIDA.some((k) => p[k]));
  const total = Math.max(4, Math.ceil(filas.length / 4) * 4);
  const PIE = M + 22, GX = 10, GY = 10;
  const CW = (AN - GX) / 2;
  const RENGLONES = [['Marca', 'marca'], ['Modelo', 'modelo'], ['Origen', 'origen'], ['Cant. pzs x cartón', 'pzsCarton'], ['Mercancía', 'mercancia'], ['Cant. pzs', 'cant']];
  const cuadrante = (n, p, x, top, h) => {
    pg.drawRectangle({ x, y: top - h, width: CW, height: h, borderColor: LINEA, borderWidth: 0.8, color: BLANCO });
    // Encabezado: número de partida
    pg.drawRectangle({ x, y: top - 17, width: CW, height: 17, color: BEIGE_SUAVE });
    pg.drawLine({ start: { x, y: top - 17 }, end: { x: x + CW, y: top - 17 }, thickness: 0.6, color: LINEA });
    const et = `PARTIDA ${n}`, ew = ancho(et, 8, FB) + 16;
    pg.drawRectangle({ x, y: top - 17, width: ew, height: 17, color: CAFE_OSC });
    txt(et, x + 8, top - 11.5, 8, FB, BEIGE);
    const pad = 9, iw = CW - 2 * pad;
    // Desc. prod.: hasta 3 renglones
    let yy = top - 17 - 12;
    txt('DESC. PROD.', x + pad, yy, 6.8, FB, GRIS);
    const dl = partir(p.desc || '', 9.5, iw - 4, FB).slice(0, 3);
    const paso = Math.max(15, Math.min(19, (h - 17 - 12) / 11));
    for (let k = 0; k < 2; k++) {
      const base = yy - 6 - (k + 1) * paso;
      const l = dl[k] || '';
      if (l) txt(l, x + pad + (iw - ancho(l, 9.5, FB)) / 2, base + 3, 9.5, FB, TINTA);
      pg.drawLine({ start: { x: x + pad, y: base }, end: { x: x + pad + iw, y: base }, thickness: 0.5, color: LINEA });
    }
    yy = yy - 6 - 2 * paso;
    // Renglones con etiqueta a la izquierda y línea para escribir
    const resto = (yy - (top - h) - 6) / RENGLONES.length;
    RENGLONES.forEach(([etq, k], i) => {
      const base = yy - (i + 1) * resto + 4;
      txt(etq + ':', x + pad, base + 3, 8.2, FB, CAFE);
      const lx = x + pad + ancho(etq + ':', 8.2, FB) + 6;
      pg.drawLine({ start: { x: lx, y: base }, end: { x: x + pad + iw, y: base }, thickness: 0.5, color: LINEA });
      const v = partir(p[k] || '', 9.5, x + pad + iw - lx - 4, FB)[0];
      if (v) txt(v, lx + (x + pad + iw - lx - ancho(v, 9.5, FB)) / 2, base + 3, 9.5, FB, TINTA);
    });
  };
  y = barra('PARTIDAS', y) - 8;
  for (let i = 0; i < total; i += 4) {
    if (i > 0) { pg = pdf.addPage([W, H]); y = barra('PARTIDAS', H - M) - 8; }
    const h = (y - PIE - GY) / 2;
    for (let j = 0; j < 4; j++) {
      const n = i + j;
      const x = M + (j % 2) * (CW + GX), top = y - Math.floor(j / 2) * (h + GY);
      cuadrante(n + 1, filas[n] || {}, x, top, h);
    }
  }

  // Pie en todas las hojas
  const pags = pdf.getPages();
  pags.forEach((p, i) => {
    const pie = `${limpio(ref || '')}  ·  Reporte de previo  ·  Hoja ${i + 1} de ${pags.length}`;
    p.drawLine({ start: { x: M, y: M + 10 }, end: { x: W - M, y: M + 10 }, thickness: 0.5, color: LINEA });
    p.drawText(pie, { x: W - M - F.widthOfTextAtSize(pie, 7.5), y: M, size: 7.5, font: F, color: GRIS });
    p.drawText('GRUPO MEJA', { x: M, y: M, size: 7.5, font: FB, color: CAFE_ICO });
  });
  return Buffer.from(await pdf.save());
}

module.exports = { limpiarPrevio, generarPrevio, CAMPOS, PARTIDA };

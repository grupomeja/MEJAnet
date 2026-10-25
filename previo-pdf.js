// OP Manzanillo: «Reporte de previo» (revisión de mercancía) en hoja carta vertical (pdf-lib, sin plantilla).
// Secciones: 1) Revisión de mercancía (cliente, fecha, tráfico, factura y logo)
//            2) Información del contenedor   3) Partidas
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ---------- Datos ----------
const CAMPOS = ['cliente', 'fecha', 'trafico', 'factura', 'buque', 'contenedor', 'tipoCont', 'sello', 'operadora', 'claveCR',
  'bultos', 'peso', 'pallets', 'palletsCant', 'palAlto', 'palLargo', 'palAncho'];
const PARTIDA = ['desc', 'marca', 'modelo', 'origen', 'lote', 'pzsCarton', 'cant', 'notas'];
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
      for (const k of PARTIDA) q[k] = t(p && p[k], k === 'desc' || k === 'notas' ? 600 : 160);
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
const LINEA = hex('#9C8A70');   // líneas: más oscuras y gruesas para que se vean al imprimir en blanco y negro
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

  const W = 612, H = 792, M = 22, AN = W - 2 * M;
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
    pg.drawLine({ start: { x, y: base }, end: { x: x + w, y: base }, thickness: 1, color: LINEA });
    return base;
  };
  const casilla = (x, yy, marcada) => {
    pg.drawRectangle({ x, y: yy, width: 9, height: 9, borderColor: CAFE_OSC, borderWidth: 1.2, color: marcada ? CAFE_OSC : BLANCO });
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
    pg.drawLine({ start: { x, y: yy - 27 }, end: { x: x + w, y: yy - 27 }, thickness: 1, color: LINEA });
    return yy - 27;
  };

  // ---------- 1. Revisión de mercancía ----------
  const HH = 64;
  pg.drawRectangle({ x: M, y: y - HH, width: AN, height: HH, color: BEIGE_SUAVE, borderColor: LINEA, borderWidth: 1.2 });
  pg.drawRectangle({ x: M, y: y - HH, width: AN, height: 3, color: CAFE_OSC });
  if (logo) {
    const lw = 140, lh = lw * logo.height / logo.width;
    pg.drawImage(logo, { x: M + 14, y: y - 32 - lh / 2, width: lw, height: lh });
  }
  const tit = 'REVISIÓN DE MERCANCÍA';
  txt(tit, M + AN - 14 - ancho(tit, 16, FB), y - 20, 16, FB, CAFE_OSC);
  const sub = 'Reporte de previo · Puerto de Manzanillo';
  txt(sub, M + AN - 14 - ancho(sub, 8), y - 31, 8, F, CAFE_ICO);
  const cli = limpio(r.cliente || '').toUpperCase();
  // Cliente grande; si no cabe en un renglón, en dos renglones un poco más chicos
  const una = ancho(cli, 14, FB) <= 330;
  const ct = una ? 14 : 11.5;
  const cliLin = partir(cli, ct, 330, FB).slice(0, 2);
  cliLin.forEach((l, i) => txt(l, M + AN - 14 - ancho(l, ct, FB), (una ? y - 51 : y - 46) - i * 12, ct, FB, GUINDA));
  y -= HH + 6;
  const c3 = (AN - 2 * 14) / 3;
  let b1 = campo('Fecha', fechaTxt(r.fecha), M, y, c3);
  let b2 = campo('Tráfico', r.trafico, M + c3 + 14, y, c3);
  let b3 = campo('Factura', r.factura, M + 2 * (c3 + 14), y, c3);
  y = Math.min(b1, b2, b3) - 10;

  // ---------- 2. Información del contenedor ----------
  y = barra('INFORMACIÓN DEL CONTENEDOR', y) - 4;
  const g = 14, c2 = (AN - g) / 2;
  b1 = campo('Buque / viaje', r.buque, M, y, c2);
  b2 = campo('Contenedor no.', r.contenedor, M + c2 + g, y, c2);
  y = Math.min(b1, b2) - 4;
  const cq = (c2 - g) / 2;
  b1 = opciones('Tipo de contenedor', TIPOS_CONT, r.tipoCont, M, y, c2);
  b2 = campo('Sello', r.sello, M + c2 + g, y, cq);
  b3 = campo('Clave CR', r.claveCR, M + c2 + g + cq + g, y, cq);
  y = Math.min(b1, b2, b3) - 4;
  const c4 = (AN - 3 * g) / 4;
  const fila4 = [['Operadora', r.operadora], ['Bultos', r.bultos], ['Peso (kg)', r.peso], ['Cant. de pallets', r.palletsCant]];
  y = Math.min(...fila4.map(([e, v], i) => campo(e, v, M + i * (c4 + g), y, c4))) - 4;
  // Pallets: tipo y medidas en el mismo renglón
  b1 = opciones('Pallets', PALLETS, r.pallets, M, y, c2);
  {
    const x0 = M + c2 + g;
    txt('MEDIDAS DE PALLET', x0, y - 8, 6.8, FB, GRIS);
    const base = y - 27, grupo = c2 / 3;
    [['ALTO', r.palAlto], ['LARGO', r.palLargo], ['ANCHO', r.palAncho]].forEach(([etq, v], i) => {
      const cx = x0 + i * grupo;
      txt(etq + ':', cx, base + 4, 8, FB, CAFE);
      const lx = cx + ancho(etq + ':', 8, FB) + 4, rx = cx + grupo - 8;
      pg.drawLine({ start: { x: lx, y: base }, end: { x: rx, y: base }, thickness: 1, color: LINEA });
      const l = partir(v || '', 10, rx - lx - 2, FB)[0];
      if (l) txt(l, lx + (rx - lx - ancho(l, 10, FB)) / 2, base + 4, 10, FB, TINTA);
    });
    b2 = base;
  }
  y = Math.min(b1, b2) - 10;

  // ---------- 3. Partidas (cuadrantes con renglones para escribir a mano) ----------
    const filas = (r.partidas || []).filter((p) => PARTIDA.some((k) => p[k]));
  const PIE = M + 22, GX = 10, GY = 10;
  const CW = (AN - GX) / 2;
  const RENGLONES = [['MARCA', 'marca'], ['MODELO', 'modelo'], ['ORIGEN', 'origen'], ['LOTE #', 'lote'], ['CANT. PZS X CARTÓN', 'pzsCarton'], ['CANT. PZS', 'cant']];
  const ET = 8.2, VT = 9.5;
  const linea = (x1, x2, yy) => pg.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: 0.9, color: LINEA });
  const valor = (v, x1, x2, base) => {
    const l = partir(v || '', VT, x2 - x1 - 4, FB)[0];
    if (l) txt(l, x1 + (x2 - x1 - ancho(l, VT, FB)) / 2, base + 3, VT, FB, TINTA);
  };
  const cuadrante = (n, p, x, top, h) => {
    pg.drawRectangle({ x, y: top - h, width: CW, height: h, color: BLANCO });
    pg.drawRectangle({ x, y: top - 17, width: CW, height: 17, color: BEIGE_SUAVE });
    // Línea bajo el encabezado y borde del cuadrante, del mismo grosor
    pg.drawLine({ start: { x, y: top - 17 }, end: { x: x + CW, y: top - 17 }, thickness: 1.2, color: LINEA });
    pg.drawRectangle({ x, y: top - h, width: CW, height: h, borderColor: LINEA, borderWidth: 1.2 });
    // Etiqueta café al final, encima de las líneas (las tapa por completo)
    const et = `PARTIDA ${n}`, ew = ancho(et, 8, FB) + 16;
    pg.drawRectangle({ x: x - 0.6, y: top - 17 - 0.6, width: ew + 0.6, height: 17 + 1.2, color: CAFE_OSC });
    txt(et, x + 8, top - 11.5, 8, FB, BEIGE);
    const pad = 9, x1 = x + pad, x2 = x + CW - pad;
    // DESC. PROD. (normalmente se captura en computadora): 2 renglones compactos
    let yy = top - 17 - 11;
    txt('DESC. PROD.:', x1, yy, ET, FB, CAFE);
    const dl = partir(p.desc || '', 9, x2 - x1 - 4, FB).slice(0, 2);
    const pd = 12.5;
    for (let k = 0; k < 2; k++) {
      const base = yy - 4 - (k + 1) * pd;
      linea(x1, x2, base);
      const l = dl[k]; if (l) txt(l, x1 + (x2 - x1 - ancho(l, 9, FB)) / 2, base + 2.5, 9, FB, TINTA);
    }
    yy -= 4 + 2 * pd + 2;
    // Renglones para escribir con pluma: 6 campos + medidas + notas
    const paso = Math.max(15, Math.min(30, (yy - (top - h) - 4) / 7));
    for (const [etq, k] of RENGLONES) {
      const base = yy - paso + 4;
      txt(etq + ':', x1, base + 3, ET, FB, CAFE);
      const lx = x1 + ancho(etq + ':', ET, FB) + 6;
      linea(lx, x2, base); valor(p[k], lx, x2, base);
      yy -= paso;
    }
    // NOTAS: renglones hasta el final del cuadrante
    const nl = partir(p.notas || '', VT, x2 - x1 - 40, F);
    let k = 0;
    while (k === 0 || yy - paso + 4 > top - h + 4) {
      const base = yy - paso + 4;
      if (k === 0) {
        txt('NOTAS:', x1, base + 3, ET, FB, CAFE);
        const lx = x1 + ancho('NOTAS:', ET, FB) + 6;
        linea(lx, x2, base);
        if (nl[0]) txt(nl[0], lx + 2, base + 3, VT, F, TINTA);
      } else {
        linea(x1, x2, base);
        if (nl[k]) txt(nl[k], x1 + 2, base + 3, VT, F, TINTA);
      }
      k++; yy -= paso;
    }
  };
  // 4 cuadrantes por hoja (2 x 2); si hay más partidas, siguen en otra hoja
  y = barra('PARTIDAS', y) - 6;
  let n = 0;
  while (n === 0 || n < filas.length) {
    if (n > 0) { pg = pdf.addPage([W, H]); y = barra('PARTIDAS', H - M) - 6; }
    const h = (y - PIE - GY) / 2;
    for (let j = 0; j < 4; j++, n++) cuadrante(n + 1, filas[n] || {}, M + (j % 2) * (CW + GX), y - Math.floor(j / 2) * (h + GY), h);
  }

  // Pie en todas las hojas
  const pags = pdf.getPages();
  pags.forEach((p, i) => {
    const pie = `${limpio(ref || '')}  ·  Reporte de previo  ·  Hoja ${i + 1} de ${pags.length}`;
    p.drawLine({ start: { x: M, y: M + 10 }, end: { x: W - M, y: M + 10 }, thickness: 0.9, color: LINEA });
    p.drawText(pie, { x: W - M - F.widthOfTextAtSize(pie, 7.5), y: M, size: 7.5, font: F, color: GRIS });
    p.drawText('GRUPO MEJA', { x: M, y: M, size: 7.5, font: FB, color: CAFE_ICO });
  });
  return Buffer.from(await pdf.save());
}

module.exports = { limpiarPrevio, generarPrevio, CAMPOS, PARTIDA };

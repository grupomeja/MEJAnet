'use strict';
// MEJAnet · OP Manzanillo — PDF del Reporte ejecutivo y del Reporte por referencia (Control de gastos)
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const CAT = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'conceptos_gastos.json'), 'utf8')));
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const limpio = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const money = (n) => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const fec = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]} ${MESES[+m[2] - 1]} ${m[1]}` : ''; };
const nomC = (c) => CAT[c] || c || '';
const pct = (v, t) => (t ? (v / t) * 100 : 0);

const INK = hex('#2B241B'), CAFE = hex('#5E4E37'), OSCURO = hex('#4A3826'), BEIGE = hex('#EAE1D3'), SUAVE = hex('#FAF6EF'),
  LIN = hex('#9C8A70'), LIN2 = hex('#DDD2C0'), GUINDA = hex('#7A1C1C'), GRIS = hex('#7A7266'), ROJO = hex('#B42318'), VERDE = hex('#1F6B41'), BARRA = hex('#8C7553'), FONDOB = hex('#EDE6DA');

// Estadísticas (mismo cálculo que la pantalla)
function estad(embs) {
  const xs = embs.filter((e) => (e.gastos || []).length);
  const R = { xs, tot: 0, ab: 0, ce: 0, n: 0, refsAb: 0, refsCe: 0, cli: {}, con: {}, mes: {}, pend: { pdf: 0, xml: 0, pago: 0, ppd: 0, comp: 0, sinFac: 0 }, nAb: 0 };
  xs.forEach((e) => {
    const ce = !!e.gastosCerrada; ce ? R.refsCe++ : R.refsAb++;
    (e.gastos || []).forEach((g) => {
      const v = +g.importe || 0; R.tot += v; R.n++; ce ? (R.ce += v) : (R.ab += v);
      const c = e.cliente || 'Sin cliente', o = R.cli[c] || (R.cli[c] = { v: 0, n: 0, refs: new Set() }); o.v += v; o.n++; o.refs.add(e.ref);
      const k = nomC(g.concepto) || 'Sin concepto', q = R.con[k] || (R.con[k] = { v: 0, n: 0 }); q.v += v; q.n++;
      const m = (g.fecha || '').slice(0, 7) || 'Sin fecha'; R.mes[m] = (R.mes[m] || 0) + v;
      if (!ce) {
        R.nAb++;
        if (!g.pdf) R.pend.pdf++; if (!g.xml) R.pend.xml++; if (!g.pago) R.pend.pago++;
        if (g.metodo === 'PPD') { R.pend.ppd++; if (!(g.cpdf && g.cxml)) R.pend.comp++; }
        if (!g.factura || /pendiente/i.test(g.factura)) R.pend.sinFac++;
      }
    });
  });
  return R;
}

async function base(titulo, sub, horizontal) {
  const pdf = await PDFDocument.create();
  const F = await pdf.embedFont(StandardFonts.Helvetica), FB = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null; try { logo = await pdf.embedPng(fs.readFileSync(path.join(__dirname, 'public', 'logo-previo.png'))); } catch { /* sin logo */ }
  const W = horizontal ? 792 : 612, H = horizontal ? 612 : 792, M = 30, AN = W - 2 * M;
  const ancho = (s, z, f = F) => f.widthOfTextAtSize(limpio(s), z);
  const corta = (s, z, w, f = F) => { s = limpio(s); if (ancho(s, z, f) <= w) return s; while (s && ancho(s + '...', z, f) > w) s = s.slice(0, -1); return s + '...'; };
  const D = { pdf, F, FB, W, H, M, AN, ancho, corta, pg: null, y: 0 };
  D.texto = (s, x, y, z, f = F, c = INK) => D.pg.drawText(limpio(s), { x, y, size: z, font: f, color: c });
  D.cab = () => {
    const y = D.y;
    D.pg.drawRectangle({ x: M, y: y - 48, width: AN, height: 48, color: SUAVE, borderColor: LIN, borderWidth: 1 });
    D.pg.drawRectangle({ x: M, y: y - 48, width: AN, height: 3, color: OSCURO });
    if (logo) { const lw = 112, lh = lw * logo.height / logo.width; D.pg.drawImage(logo, { x: M + 12, y: y - 24 - lh / 2, width: lw, height: lh }); }
    D.texto(titulo, M + AN - 12 - ancho(titulo, 15, FB), y - 21, 15, FB, OSCURO);
    D.texto(sub, M + AN - 12 - ancho(sub, 9.5, FB), y - 36, 9.5, FB, GUINDA);
    D.y -= 60;
  };
  D.nueva = () => { D.pg = pdf.addPage([W, H]); D.y = H - M; D.cab(); };
  D.espacio = (h) => { if (D.y - h < M + 18) { D.nueva(); return true; } return false; };
  D.seccion = (t) => { D.espacio(40); D.texto(t, M, D.y - 11, 10.5, FB, OSCURO); D.pg.drawLine({ start: { x: M, y: D.y - 16 }, end: { x: M + AN, y: D.y - 16 }, thickness: 1, color: LIN }); D.y -= 22; };
  D.barra = (x, y, w, frac) => { D.pg.drawRectangle({ x, y, width: w, height: 5, color: FONDOB }); D.pg.drawRectangle({ x, y, width: Math.max(1.5, w * Math.min(1, frac)), height: 5, color: BARRA }); };
  // Tabla genérica: cols = [[titulo, ancho(0 = resto), alin, fuente?]] ; filas = [[...valores]] ; barra opcional {col, frac(i)}
  D.tabla = (cols, filas, op = {}) => {
    cols = cols.map((c) => c.slice()); const fijo = cols.reduce((a, c) => a + c[1], 0); const resto = cols.find((c) => !c[1]); if (resto) resto[1] = AN - fijo;
    const z = op.z || 8, alto = op.alto || 15;
    const enc = () => {
      D.pg.drawRectangle({ x: M, y: D.y - 15, width: AN, height: 15, color: BEIGE });
      let x = M; for (const [n, w, al] of cols) { const tx = al === 'r' ? x + w - 5 - ancho(n, 6.8, FB) : al === 'c' ? x + (w - ancho(n, 6.8, FB)) / 2 : x + 5; D.texto(n, tx, D.y - 10.5, 6.8, FB, CAFE); x += w; }
      D.y -= 15;
    };
    D.espacio(15 + alto * Math.min(3, filas.length || 1)); enc();
    if (!filas.length) { D.texto('Sin datos', M + 5, D.y - 11, z, F, GRIS); D.y -= alto; }
    filas.forEach((f, i) => {
      if (D.espacio(alto)) enc();
      let x = M;
      cols.forEach(([, w, al, neg], k) => {
        if (op.barra && op.barra.col === k) { D.barra(x + 4, D.y - alto / 2 - 2.5, w - 8, op.barra.frac(i)); x += w; return; }
        const v = f[k] == null ? '' : String(f[k]); const fo = neg ? FB : F; const s = corta(v, z, w - 10, fo);
        const tx = al === 'r' ? x + w - 5 - ancho(s, z, fo) : al === 'c' ? x + (w - ancho(s, z, fo)) / 2 : x + 5;
        D.texto(s, tx, D.y - alto + 4.5, z, fo, op.color ? op.color(i, k) || INK : INK); x += w;
      });
      D.pg.drawLine({ start: { x: M, y: D.y - alto }, end: { x: M + AN, y: D.y - alto }, thickness: 0.5, color: LIN2 });
      D.y -= alto;
    });
    D.y -= 10;
  };
  D.fin = async () => {
    const pags = pdf.getPages(); const hoy = new Date().toLocaleString('es-MX', { timeZone: 'America/Matamoros' });
    pags.forEach((p, i) => p.drawText(limpio(`GRUPO MEJA  ·  OP Manzanillo  ·  Generado ${hoy}  ·  Hoja ${i + 1} de ${pags.length}`), { x: M, y: M - 14, size: 7, font: F, color: GRIS }));
    return Buffer.from(await pdf.save());
  };
  D.nueva();
  return D;
}

async function reporteEjecutivo(embs) {
  const R = estad(embs);
  const D = await base('REPORTE EJECUTIVO', `CONTROL DE GASTOS  ·  ${R.xs.length} REFERENCIAS  ·  ${R.n} FACTURAS`, false);
  const { M, AN, FB, F } = D;
  const cli = Object.entries(R.cli).sort((a, b) => b[1].v - a[1].v);
  const con = Object.entries(R.con).sort((a, b) => b[1].v - a[1].v);
  const conN = Object.entries(R.con).filter(([k]) => k !== 'Sin concepto').sort((a, b) => b[1].n - a[1].n)[0];
  // Indicadores (3 x 2)
  const K = [
    ['GASTO TOTAL', '$' + money(R.tot), `${R.xs.length} referencias`],
    ['REFERENCIAS ABIERTAS', '$' + money(R.ab), `${R.refsAb} referencias`],
    ['REFERENCIAS CERRADAS', '$' + money(R.ce), `${R.refsCe} referencias`],
    ['PROMEDIO POR REFERENCIA', '$' + money(R.xs.length ? R.tot / R.xs.length : 0), `${R.n} facturas · prom. factura $${money(R.n ? R.tot / R.n : 0)}`],
    ['CLIENTE CON MAYOR GASTO', cli[0] ? '$' + money(cli[0][1].v) : '-', cli[0] ? `${cli[0][0]} · ${pct(cli[0][1].v, R.tot).toFixed(1)}%` : ''],
    ['CONCEPTO MAS UTILIZADO', conN ? '$' + money(conN[1].v) : '-', conN ? `${conN[0]} · ${conN[1].n} ${conN[1].n === 1 ? 'vez' : 'veces'}` : ''],
  ];
  const kw = (AN - 16) / 3, kh = 46;
  K.forEach(([l, v, s], i) => {
    const x = M + (i % 3) * (kw + 8), y = D.y - Math.floor(i / 3) * (kh + 8);
    D.pg.drawRectangle({ x, y: y - kh, width: kw, height: kh, color: SUAVE, borderColor: LIN2, borderWidth: 1 });
    D.texto(l, x + 9, y - 12, 6.8, FB, BARRA);
    D.texto(v, x + 9, y - 29, 15, FB, OSCURO);
    D.texto(D.corta(s, 7.5, kw - 18), x + 9, y - 40, 7.5, F, GRIS);
  });
  D.y -= 2 * kh + 8 + 16;
  // Pendientes
  D.seccion('PENDIENTES DE DOCUMENTACION  (referencias abiertas)');
  const P = [['Facturas sin PDF', R.pend.pdf, R.nAb], ['Facturas sin XML', R.pend.xml, R.nAb], ['Sin comprobante de pago', R.pend.pago, R.nAb], ['Facturas PPD', R.pend.ppd, null], ['PPD sin complemento', R.pend.comp, R.pend.ppd], ['Sin numero de factura', R.pend.sinFac, R.nAb]];
  const pw = (AN - 25) / 6;
  P.forEach(([l, n, de], i) => {
    const x = M + i * (pw + 5);
    D.pg.drawRectangle({ x, y: D.y - 40, width: pw, height: 40, borderColor: LIN2, borderWidth: 1 });
    const s = String(n); D.texto(s, x + (pw - D.ancho(s, 15, FB)) / 2, D.y - 17, 15, FB, n && i !== 3 ? ROJO : OSCURO);
    const l2 = D.corta(l, 6.8, pw - 6); D.texto(l2, x + (pw - D.ancho(l2, 6.8)) / 2, D.y - 27, 6.8, F, INK);
    if (de != null) { const d = `de ${de}`; D.texto(d, x + (pw - D.ancho(d, 6.3)) / 2, D.y - 35.5, 6.3, F, GRIS); }
  });
  D.y -= 54;
  D.seccion('GASTO POR CLIENTE');
  D.tabla([['CLIENTE', 0], ['REFS', 40, 'c'], ['FACTURAS', 54, 'c'], ['TOTAL', 84, 'r', true], ['%', 44, 'r'], ['', 100]],
    cli.map(([k, o]) => [k, o.refs.size, o.n, '$' + money(o.v), pct(o.v, R.tot).toFixed(1) + '%', '']), { barra: { col: 5, frac: (i) => cli[i][1].v / (cli[0][1].v || 1) } });
  D.seccion('GASTO POR CONCEPTO');
  D.tabla([['CONCEPTO', 0], ['VECES', 44, 'c'], ['TOTAL', 84, 'r', true], ['PROMEDIO', 76, 'r'], ['%', 44, 'r'], ['', 100]],
    con.map(([k, o]) => [k, o.n, '$' + money(o.v), '$' + money(o.v / o.n), pct(o.v, R.tot).toFixed(1) + '%', '']), { barra: { col: 5, frac: (i) => con[i][1].v / (con[0][1].v || 1) } });
  const meses = Object.entries(R.mes).sort((a, b) => a[0].localeCompare(b[0])); const mMax = Math.max(1, ...meses.map((m) => m[1]));
  D.seccion('GASTO POR MES  (fecha de transferencia)');
  D.tabla([['MES', 0], ['TOTAL', 96, 'r', true], ['', 200]],
    meses.map(([m, v]) => [m === 'Sin fecha' ? m : `${MESES[+m.slice(5) - 1]} ${m.slice(0, 4)}`, '$' + money(v), '']), { barra: { col: 2, frac: (i) => meses[i][1] / mMax } });
  return D.fin();
}

async function reporteReferencias(embs) {
  const xs = embs.filter((e) => (e.gastos || []).length).sort((a, b) => String(b.ref || '').localeCompare(String(a.ref || '')));
  const tot = xs.reduce((a, e) => a + (e.gastos || []).reduce((s, g) => s + (+g.importe || 0), 0), 0);
  const nf = xs.reduce((a, e) => a + e.gastos.length, 0);
  const D = await base('REPORTE POR REFERENCIA', `CONTROL DE GASTOS  ·  ${xs.length} REFERENCIAS  ·  ${nf} FACTURAS  ·  $${money(tot)}`, true);
  const { M, AN, FB, F } = D;
  const COLS = [['#', 18, 'c'], ['FACTURA', 74, '', true], ['PROVEEDOR', 128], ['CONCEPTO', 118], ['DETALLE', 0], ['FECHA TRANSF.', 66, 'c'], ['METODO', 42, 'c'], ['PDF', 26, 'c'], ['XML', 26, 'c'], ['PAGO', 30, 'c'], ['IMPORTE', 76, 'r', true]];
  xs.forEach((e) => {
    const g = e.gastos, t = g.reduce((s, x) => s + (+x.importe || 0), 0);
    D.espacio(24 + 15 + 15 * Math.min(3, g.length));
    // Encabezado de la referencia
    D.pg.drawRectangle({ x: M, y: D.y - 20, width: AN, height: 20, color: OSCURO });
    D.texto(e.ref || '', M + 8, D.y - 14, 10.5, FB, BEIGE);
    D.texto(D.corta(e.cliente || '', 9, 300, F), M + 8 + D.ancho(e.ref || '', 10.5, FB) + 14, D.y - 14, 9, F, BEIGE);
    const der = `${e.gastosCerrada ? 'CERRADA' : 'ABIERTA'}   ·   ${g.length} factura${g.length === 1 ? '' : 's'}   ·   $${money(t)}`;
    D.texto(der, M + AN - 8 - D.ancho(der, 9.5, FB), D.y - 14, 9.5, FB, BEIGE);
    D.y -= 22;
    D.tabla(COLS, g.map((x, i) => [i + 1, x.factura || 'PENDIENTE', x.proveedor, nomC(x.concepto), x.detalle, fec(x.fecha), x.metodo || '-', x.pdf ? 'SI' : '-', x.xml ? 'SI' : '-', x.pago ? 'SI' : '-', '$' + money(x.importe)]),
      { z: 7.5, alto: 14, color: (i, k) => (k === 1 && (!g[i].factura || /pendiente/i.test(g[i].factura)) ? GUINDA : (k >= 7 && k <= 9 && !g[i][['pdf', 'xml', 'pago'][k - 7]]) ? ROJO : null) });
  });
  D.espacio(30);
  const tt = `TOTAL GENERAL   $${money(tot)} MXN`;
  D.pg.drawRectangle({ x: M + AN - 260, y: D.y - 24, width: 260, height: 24, color: BEIGE });
  D.texto(tt, M + AN - 12 - D.ancho(tt, 12, FB), D.y - 16.5, 12, FB, OSCURO);
  return D.fin();
}

module.exports = { reporteEjecutivo, reporteReferencias };

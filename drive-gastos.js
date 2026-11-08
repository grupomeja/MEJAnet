// OP Manzanillo · copia de los PDF/XML de gastos y del resumen por referencia en Google Drive.
// Usa un pequeño Google Apps Script publicado por el dueño del Drive (ver docs/drive-gastos.gs).
// Variables de entorno: OPM_DRIVE_URL (URL /exec del script) y OPM_DRIVE_TOKEN (clave compartida).
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const URL_ = () => process.env.OPM_DRIVE_URL || '';
const TOKEN = () => process.env.OPM_DRIVE_TOKEN || '';
const activo = () => !!(URL_() && TOKEN());
const CAT = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'conceptos_gastos.json'), 'utf8')));
const carpetaDe = (ref) => String(ref || '').replace(/\//g, '-').replace(/[^\w.\- ]+/g, '').trim() || 'SIN REFERENCIA';
const limpioNombre = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

// Las llamadas a una misma carpeta van en fila, para que Drive no cree la carpeta dos veces
const colas = new Map();
function enviar(datos) {
  const k = datos.carpeta || '_';
  const p = (colas.get(k) || Promise.resolve()).then(() => enviarYa(datos), () => enviarYa(datos));
  colas.set(k, p.catch(() => {}));
  return p;
}
async function enviarYa(datos) {
  const r = await fetch(URL_(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN(), ...datos }), redirect: 'follow' });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { throw new Error(`Drive respondió ${r.status}: ${txt.slice(0, 120)}`); }
  if (j.error) throw new Error('Drive: ' + j.error);
  return j;
}

// ---------- Resumen de gastos (PDF) ----------
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const limpio = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const money = (n) => (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const fec = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]} ${MESES[+m[2] - 1]} ${m[1]}` : ''; };
async function resumenPDF(e) {
  const pdf = await PDFDocument.create();
  const F = await pdf.embedFont(StandardFonts.Helvetica), FB = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null; try { logo = await pdf.embedPng(fs.readFileSync(path.join(__dirname, 'public', 'logo-previo.png'))); } catch { /* sin logo */ }
  const W = 792, H = 612, M = 28, AN = W - 2 * M;
  const INK = hex('#2B241B'), CAFE = hex('#5E4E37'), BEIGE = hex('#EAE1D3'), SUAVE = hex('#FAF6EF'), LIN = hex('#9C8A70'), GUINDA = hex('#7A1C1C'), GRIS = hex('#7A7266');
  let pg = pdf.addPage([W, H]); let y = H - M;
  const ancho = (s, z, f = F) => f.widthOfTextAtSize(limpio(s), z);
  const corta = (s, z, w, f = F) => { s = limpio(s); if (ancho(s, z, f) <= w) return s; while (s && ancho(s + '...', z, f) > w) s = s.slice(0, -1); return s + '...'; };
  const cab = () => {
    pg.drawRectangle({ x: M, y: y - 50, width: AN, height: 50, color: SUAVE, borderColor: LIN, borderWidth: 1 });
    pg.drawRectangle({ x: M, y: y - 50, width: AN, height: 3, color: hex('#4A3826') });
    if (logo) { const lw = 120, lh = lw * logo.height / logo.width; pg.drawImage(logo, { x: M + 12, y: y - 25 - lh / 2, width: lw, height: lh }); }
    const t = 'RESUMEN DE GASTOS', r = `${e.ref || ''}  ·  ${e.cliente || ''}`;
    pg.drawText(t, { x: M + AN - 12 - ancho(t, 15, FB), y: y - 22, size: 15, font: FB, color: hex('#4A3826') });
    pg.drawText(limpio(r), { x: M + AN - 12 - ancho(r, 10.5, FB), y: y - 38, size: 10.5, font: FB, color: GUINDA });
    y -= 62;
  };
  const COLS = [['#', 18, 'c'], ['FACTURA', 70], ['PROVEEDOR', 120], ['CONCEPTO', 110], ['DETALLE', 0], ['IMPORTE', 74, 'r'], ['FECHA TRANSF.', 66, 'c'], ['METODO', 42, 'c'], ['PDF', 26, 'c'], ['XML', 26, 'c'], ['PAGO', 30, 'c'], ['COMPLEM.', 48, 'c']];
  const fijo = COLS.reduce((a, c) => a + c[1], 0); COLS[4][1] = AN - fijo;
  const encab = () => {
    pg.drawRectangle({ x: M, y: y - 16, width: AN, height: 16, color: BEIGE });
    let x = M; for (const [n, w, al] of COLS) { const tx = al === 'r' ? x + w - 4 - ancho(n, 7, FB) : al === 'c' ? x + (w - ancho(n, 7, FB)) / 2 : x + 4; pg.drawText(n, { x: tx, y: y - 11, size: 7, font: FB, color: CAFE }); x += w; }
    y -= 16;
  };
  cab(); encab();
  let tot = 0;
  (e.gastos || []).forEach((g, i) => {
    if (y - 18 < M + 40) { pg = pdf.addPage([W, H]); y = H - M; cab(); encab(); }
    const vals = [String(i + 1), g.factura || 'PENDIENTE', g.proveedor, CAT[g.concepto] || g.concepto, g.detalle, money(g.importe), fec(g.fecha), g.metodo || '-', g.pdf ? 'SI' : '-', g.xml ? 'SI' : '-', g.pago ? 'SI' : '-', g.metodo === 'PPD' ? (g.cpdf && g.cxml ? 'SI' : g.cpdf || g.cxml ? 'PARCIAL' : 'FALTA') : '-'];
    let x = M;
    COLS.forEach(([, w, al], k) => {
      const s = corta(vals[k] || '', 7.5, w - 8, k === 1 ? FB : F);
      const tx = al === 'r' ? x + w - 4 - ancho(s, 7.5, F) : al === 'c' ? x + (w - ancho(s, 7.5)) / 2 : x + 4;
      pg.drawText(s, { x: tx, y: y - 12, size: 7.5, font: k === 1 || k === 5 ? FB : F, color: k === 1 && !g.factura ? GUINDA : INK });
      x += w;
    });
    pg.drawLine({ start: { x: M, y: y - 18 }, end: { x: M + AN, y: y - 18 }, thickness: 0.6, color: LIN });
    tot += +g.importe || 0; y -= 18;
  });
  y -= 8;
  const tt = `TOTAL  $${money(tot)} MXN`;
  pg.drawRectangle({ x: M + AN - 220, y: y - 22, width: 220, height: 22, color: BEIGE });
  pg.drawText(tt, { x: M + AN - 12 - ancho(tt, 12, FB), y: y - 15.5, size: 12, font: FB, color: hex('#4A3826') });
  const est = e.gastosCerrada ? 'Referencia cerrada' : 'Referencia abierta';
  pg.drawText(est, { x: M, y: y - 15, size: 9, font: FB, color: e.gastosCerrada ? hex('#1F6B41') : CAFE });
  const pags = pdf.getPages();
  const hoy = new Date().toLocaleString('es-MX', { timeZone: 'America/Matamoros' });
  pags.forEach((p, i) => p.drawText(limpio(`GRUPO MEJA  ·  Generado ${hoy}  ·  Hoja ${i + 1} de ${pags.length}`), { x: M, y: M - 12, size: 7, font: F, color: GRIS }));
  return Buffer.from(await pdf.save());
}

// ---------- Sincronización ----------
const pendientesResumen = new Map();
function programarResumen(e, log = console) {
  if (!activo() || !e || !e.ref) return;
  clearTimeout(pendientesResumen.get(e.ref));
  pendientesResumen.set(e.ref, setTimeout(async () => {
    pendientesResumen.delete(e.ref);
    try {
      const buf = await resumenPDF(e);
      await enviar({ accion: 'subir', carpeta: carpetaDe(e.ref), nombre: `RESUMEN DE GASTOS ${carpetaDe(e.ref)}.pdf`, tipo: 'application/pdf', base64: buf.toString('base64'), reemplazar: true });
    } catch (err) { log.error('Drive (resumen ' + e.ref + '):', err.message); }
  }, 8000));
}
// Compara los gastos antes y después del cambio: sube los archivos nuevos y manda a la papelera los quitados
async function sincronizar(antes, despues, { leerArchivo, guardarDriveId, leerDriveId }) {
  if (!activo() || !despues) return;
  const lista = (d) => { const m = new Map(); (d && d.gastos || []).forEach((g) => ['pdf', 'xml', 'pago', 'cpdf', 'cxml'].forEach((k) => { if (g[k] && g[k].id) m.set(g[k].id, { g, k }); })); return m; };
  const A = lista(antes), D = lista(despues);
  const carpeta = carpetaDe(despues.ref);
  for (const [aid, { g, k }] of D) {
    if (A.has(aid)) continue;
    try {
      const f = await leerArchivo(aid); if (!f) continue;
      const base = limpioNombre(g.factura) || limpioNombre(String(f.nombre || '').replace(/\.(pdf|xml)$/i, '')) || 'SIN FACTURA';
      const r = await enviar({ accion: 'subir', carpeta, nombre: `${base}${g.proveedor ? ' - ' + limpioNombre(g.proveedor) : ''}${k === 'pago' ? ' - PAGO' : k[0] === 'c' ? ' - COMPLEMENTO' : ''}.${k === 'xml' || k === 'cxml' ? 'xml' : 'pdf'}`, tipo: f.tipo, base64: Buffer.from(f.datos).toString('base64') });
      if (r.id) await guardarDriveId(aid, r.id);
    } catch (err) { console.error('Drive (subir ' + aid + '):', err.message); }
  }
  for (const aid of A.keys()) {
    if (D.has(aid)) continue;
    try { const did = await leerDriveId(aid); if (did) await enviar({ accion: 'borrar', id: did }); } catch (err) { console.error('Drive (borrar ' + aid + '):', err.message); }
  }
  const cambio = JSON.stringify(antes && antes.gastos || []) !== JSON.stringify(despues.gastos || []) || !!(antes && antes.gastosCerrada) !== !!despues.gastosCerrada;
  if (cambio) programarResumen(despues);
}

// ---------- Referencias consecutivas (Google Sheet MANZANILLO 26) ----------
// Requiere la versión 2 del Apps Script; con la versión anterior no se llama para no crear carpetas basura.
let versionScript = 0, versionHora = 0;
async function scriptListo() {
  if (!activo()) return false;
  if (versionScript >= 4 && Date.now() - versionHora < 10 * 60e3) return true;
  try { const r = await fetch(URL_(), { redirect: 'follow' }); const j = JSON.parse(await r.text()); versionScript = +j.version || 1; }
  catch { versionScript = 0; }
  versionHora = Date.now();
  return versionScript >= 2;
}
async function siguienteRef(ocupadas) {
  if (!(await scriptListo())) throw new Error('Falta actualizar el Apps Script de Google (versión 2) para asignar referencias.');
  return (await enviarYa({ accion: 'siguienteRef', ocupadas })).ref;
}
async function actualizarRef(ref, cliente, refAnterior) {
  if (!(await scriptListo()) || versionScript < 4) return null;
  return enviarYa({ accion: 'actualizarRef', ref, cliente, refAnterior });
}
async function borrarRef(ref) {
  if (!(await scriptListo()) || versionScript < 3) return null;
  return enviarYa({ accion: 'borrarRef', ref });
}
async function registrarRef(ref, cliente) {
  if (!(await scriptListo())) return null;
  return enviarYa({ accion: 'registrarRef', ref, cliente });
}

module.exports = { activo, sincronizar, programarResumen, resumenPDF, carpetaDe, siguienteRef, registrarRef, borrarRef, actualizarRef };

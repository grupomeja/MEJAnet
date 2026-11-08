// MEJAnet · OP Manzanillo → Google Drive (CONTROL DE GASTOS) y control de referencias (MANZANILLO 26)
// Pegar en script.google.com, cambiar TOKEN por la clave que te dé Claude y publicar como «Aplicación web»
// (Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario).
// Para actualizar: Implementar → Administrar implementaciones → ✏️ → Versión: «Nueva versión» → Implementar
// (así la URL /exec no cambia). Google pedirá autorizar el acceso a Hojas de cálculo: acéptalo.
const TOKEN = 'PEGAR_AQUI_LA_CLAVE';
const CARPETA_RAIZ = '1snW-JxqCFLN7jFdPLph_-QYQTkBhznYL'; // OPERACION_MZO / 2026 / CONTROL DE GASTOS
const HOJA_REFS = '1re5tLi7ZgxXwgELUTBv55e1wgEbK1EqDXnIyQyxDuHE'; // control-MEJA / 2026 / MANZANILLO / MANZANILLO 26
const ANIO = '26';
const VERSION = 2;

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return salida({ error: 'no autorizado' });
    if (d.accion === 'borrar') { DriveApp.getFileById(d.id).setTrashed(true); return salida({ ok: true }); }
    if (d.accion === 'siguienteRef') return salida(siguienteRef(d.ocupadas || []));
    if (d.accion === 'registrarRef') return salida(registrarRef(d.ref, d.cliente));
    if (d.accion && d.accion !== 'subir') return salida({ error: 'acción desconocida' });
    const raiz = DriveApp.getFolderById(CARPETA_RAIZ);
    const it = raiz.getFoldersByName(d.carpeta);
    const carpeta = it.hasNext() ? it.next() : raiz.createFolder(d.carpeta);
    if (d.reemplazar) { const viejos = carpeta.getFilesByName(d.nombre); while (viejos.hasNext()) viejos.next().setTrashed(true); }
    const blob = Utilities.newBlob(Utilities.base64Decode(d.base64), d.tipo, d.nombre);
    const f = carpeta.createFile(blob);
    return salida({ ok: true, id: f.getId(), url: f.getUrl() });
  } catch (err) { return salida({ error: String(err) }); }
}

// ---------- Referencias consecutivas (columna MEJA) ----------
function hojaRefs() {
  const h = SpreadsheetApp.openById(HOJA_REFS).getSheets()[0];
  const enc = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map((x) => String(x).trim().toUpperCase());
  const cMeja = enc.indexOf('MEJA') + 1, cCli = enc.indexOf('CLIENTE') + 1;
  if (!cMeja) throw new Error('No encontré la columna MEJA');
  return { h, cMeja, cCli };
}
function leerRefs(h, cMeja) {
  const n = Math.max(h.getLastRow() - 1, 0);
  return n ? h.getRange(2, cMeja, n, 1).getValues().map((r) => String(r[0]).trim().toUpperCase()) : [];
}
const numDe = (s) => { const m = new RegExp('^MA?(\\d{1,4})\\/' + ANIO).exec(s); return m ? +m[1] : null; };
function calcular(refs, ocupadas) {
  const usadas = new Set();
  refs.concat(ocupadas.map((x) => String(x).trim().toUpperCase())).forEach((s) => { const n = numDe(s); if (n != null) usadas.add(n); });
  let ultimo = 0; refs.forEach((s) => { const n = numDe(s); if (n != null && /^MA?\d{1,4}\/\d{2}$/.test(s)) ultimo = n; });
  let n = ultimo + 1; while (usadas.has(n)) n++;
  return 'MA' + String(n).padStart(3, '0') + '/' + ANIO;
}
function siguienteRef(ocupadas) {
  const { h, cMeja } = hojaRefs();
  return { ok: true, ref: calcular(leerRefs(h, cMeja), ocupadas) };
}
function registrarRef(ref, cliente) {
  ref = String(ref || '').trim().toUpperCase();
  if (!ref) return { error: 'falta la referencia' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const { h, cMeja, cCli } = hojaRefs();
    const refs = leerRefs(h, cMeja);
    const i = refs.indexOf(ref);
    if (i >= 0) { if (cCli && cliente && !String(h.getRange(i + 2, cCli).getValue()).trim()) h.getRange(i + 2, cCli).setValue(cliente); return { ok: true, existente: true, fila: i + 2 }; }
    let ult = refs.length; while (ult > 0 && !refs[ult - 1]) ult--;
    const fila = ult + 2;
    h.getRange(fila, cMeja).setValue(ref);
    if (cCli) h.getRange(fila, cCli).setValue(String(cliente || '').toUpperCase());
    const a = h.getRange(fila, 1);
    if (cMeja !== 1 && cCli !== 1 && !String(a.getValue()).trim() && fila > 2) { const prev = +h.getRange(fila - 1, 1).getValue(); if (prev) a.setValue(prev + 1); }
    SpreadsheetApp.flush();
    return { ok: true, fila };
  } finally { lock.releaseLock(); }
}

function doGet() { return salida({ ok: true, servicio: 'MEJAnet · Control de gastos y referencias', version: VERSION }); }
function salida(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// Google Apps Script: (1) recibe el PDF de cada orden y lo guarda en la carpeta "Ordenes de Carga" de Drive,
// (2) entrega al tablero el resultado de la revisión de OC_TERMINADAS (archivo _tablero_resultados.json),
// (3) copia las Entradas Bodega de MEJAnet a la hoja de Google "Entradas Bodega".
// Cambia TOKEN por la misma clave que pongas en Render como DRIVE_TOKEN.
const TOKEN = 'A9S8D7F6G5H4';
const CARPETA_ID = '1mvLs_ZEfAYozwmjxtbegqPbziONLOxRZ'; // carpeta "Ordenes de Carga"
const HOJA_EB_ID = '18gdfi8oqDxVnrdcj4yWxjHaR2OEC-kr5V6QnQ0Evw2E'; // hoja de Google "Entradas Bodega"

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return salida({ ok: false, error: 'token incorrecto' });
    if (d.accion === 'eb_fila') return salida(entradaBodegaFila(d.buscar, d.fila));
    if (d.accion === 'eb_todo') return salida(entradaBodegaTodo(d.filas));
    const carpeta = DriveApp.getFolderById(CARPETA_ID);
    // Si ya existe un archivo con ese nombre, no se duplica
    const existentes = carpeta.getFilesByName(d.nombre);
    if (existentes.hasNext()) return salida({ ok: true, id: existentes.next().getId(), repetido: true });
    const pdf = Utilities.newBlob(Utilities.base64Decode(d.pdf), 'application/pdf', d.nombre);
    return salida({ ok: true, id: carpeta.createFile(pdf).getId() });
  } catch (err) {
    return salida({ ok: false, error: String(err) });
  }
}

// El tablero consulta aquí lo que se leyó de las órdenes terminadas.
function doGet(e) {
  try {
    if (!e.parameter || e.parameter.token !== TOKEN) return salida({ ok: false, error: 'token incorrecto' });
    const it = DriveApp.getFolderById(CARPETA_ID).getFilesByName('_tablero_resultados.json');
    if (!it.hasNext()) return salida({ ok: true, archivos: [] });
    return salida(JSON.parse(it.next().getBlob().getDataAsString()), true);
  } catch (err) {
    return salida({ ok: false, error: String(err) });
  }
}

function salida(obj, sinOk) {
  if (sinOk) obj.ok = true;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Entradas Bodega ----------
// Columnas: REFERENCIA, FECHA ARRIBO, CLIENTE, BULTOS, DESCRIPCION, PESO (Lbs), PESO (KGS),
//           LINEA FLETERA, TRACKING #, P.O., PROVEEDOR, PEDIMENTO, TIPO, NOTAS
const NUMERICAS_EB = [3, 5, 6]; // BULTOS, PESO (Lbs), PESO (KGS)

function hojaEB() {
  return SpreadsheetApp.openById(HOJA_EB_ID).getSheets()[0];
}

// Zona horaria de la hoja: la fecha se arma en esa zona para que no se recorra un día
function zonaEB(hoja) {
  return hoja.getParent().getSpreadsheetTimeZone();
}

// Convierte los textos que manda MEJAnet a lo que va en cada celda
function celdasEB(fila, zona) {
  return fila.map(function (v, i) {
    v = String(v == null ? '' : v).trim();
    if (v === '') return '';
    if (i === 1) { // fecha AAAA-MM-DD
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      return m ? Utilities.parseDate(v + ' 12:00', zona, 'yyyy-MM-dd HH:mm') : "'" + v;
    }
    if (NUMERICAS_EB.indexOf(i) >= 0) return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : "'" + v;
    return v;
  });
}

// Agrega un registro o corrige el que tenga la referencia `buscar` (la anterior, si cambió)
function entradaBodegaFila(buscar, fila) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const hoja = hojaEB();
    const celdas = [celdasEB(fila, zonaEB(hoja))];
    if (hoja.getMaxColumns() < celdas[0].length) hoja.insertColumnsAfter(hoja.getMaxColumns(), celdas[0].length - hoja.getMaxColumns());
    const ultima = hoja.getLastRow();
    let n = 0;
    if (ultima > 1) {
      const encontrada = hoja.getRange(2, 1, ultima - 1, 1).createTextFinder(buscar || fila[0]).matchEntireCell(true).findNext();
      if (encontrada) n = encontrada.getRow();
    }
    if (!n) {
      n = ultima + 1;
      if (n > hoja.getMaxRows()) hoja.insertRowsAfter(hoja.getMaxRows(), 500);
    }
    hoja.getRange(n, 1, 1, celdas[0].length).setValues(celdas);
    return { ok: true, fila: n };
  } finally {
    lock.releaseLock();
  }
}

// Reescribe toda la hoja con los registros de MEJAnet
function entradaBodegaTodo(filas) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const hoja = hojaEB();
    const total = filas.length + 1;
    if (hoja.getMaxRows() < total) hoja.insertRowsAfter(hoja.getMaxRows(), total - hoja.getMaxRows() + 200);
    const ancho = filas.length ? filas[0].length : hoja.getLastColumn();
    if (hoja.getMaxColumns() < ancho) hoja.insertColumnsAfter(hoja.getMaxColumns(), ancho - hoja.getMaxColumns());
    if (hoja.getLastRow() > 1) hoja.getRange(2, 1, hoja.getLastRow() - 1, Math.max(ancho, hoja.getLastColumn())).clearContent();
    if (filas.length) { const zona = zonaEB(hoja); hoja.getRange(2, 1, filas.length, ancho).setValues(filas.map(function (f) { return celdasEB(f, zona); })); }
    return { ok: true, filas: filas.length };
  } finally {
    lock.releaseLock();
  }
}

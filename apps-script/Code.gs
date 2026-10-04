// Google Apps Script: (1) recibe el PDF de cada orden y lo guarda en la carpeta "Ordenes de Carga" de Drive,
// (2) entrega al tablero el resultado de la revisión de OC_TERMINADAS (archivo _tablero_resultados.json).
// Cambia TOKEN por la misma clave que pongas en Render como DRIVE_TOKEN.
const TOKEN = 'PON_AQUI_TU_CLAVE';
const CARPETA_ID = '1mvLs_ZEfAYozwmjxtbegqPbziONLOxRZ'; // carpeta "Ordenes de Carga"

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return salida({ ok: false, error: 'token incorrecto' });
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

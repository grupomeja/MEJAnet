// Google Apps Script: recibe el PDF de cada orden y lo guarda en la carpeta "Ordenes de Carga" de Drive.
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

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// MEJAnet · OP Manzanillo → Google Drive (CONTROL DE GASTOS)
// Pegar en script.google.com, cambiar TOKEN por la clave que te dé Claude y publicar como «Aplicación web»
// (Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario).
const TOKEN = 'PEGAR_AQUI_LA_CLAVE';
const CARPETA_RAIZ = '1snW-JxqCFLN7jFdPLph_-QYQTkBhznYL'; // OPERACION_MZO / 2026 / CONTROL DE GASTOS

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return salida({ error: 'no autorizado' });
    if (d.accion === 'borrar') { DriveApp.getFileById(d.id).setTrashed(true); return salida({ ok: true }); }
    const raiz = DriveApp.getFolderById(CARPETA_RAIZ);
    const it = raiz.getFoldersByName(d.carpeta);
    const carpeta = it.hasNext() ? it.next() : raiz.createFolder(d.carpeta);
    if (d.reemplazar) { const viejos = carpeta.getFilesByName(d.nombre); while (viejos.hasNext()) viejos.next().setTrashed(true); }
    const blob = Utilities.newBlob(Utilities.base64Decode(d.base64), d.tipo, d.nombre);
    const f = carpeta.createFile(blob);
    return salida({ ok: true, id: f.getId(), url: f.getUrl() });
  } catch (err) { return salida({ error: String(err) }); }
}
function doGet() { return salida({ ok: true, servicio: 'MEJAnet · Control de gastos' }); }
function salida(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

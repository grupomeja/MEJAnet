// Comunicación con el Google Apps Script (ver apps-script/Code.gs):
// guarda el PDF de cada orden en Google Drive y copia las Entradas Bodega a las hojas de Google.
//
// Cómo responde Google: al recibir el POST, el script se ejecuta y Google contesta con una
// redirección (302) a otra dirección donde está el resultado. Esa segunda lectura a veces falla
// (404 o una página que no es JSON) aunque el script SÍ hizo el trabajo; por eso:
//  1. La redirección se sigue a mano y el resultado se lee con un GET.
//  2. Las llamadas van de una en una (en fila), para que no se estorben dentro del script (Lock timeout).
//  3. Si algo falla se reintenta hasta 3 veces. Es seguro repetir: guardar un PDF que ya existe no lo
//     duplica, y copiar una entrada busca su referencia y la reescribe en la misma fila.
function configurado() {
  return !!(process.env.DRIVE_WEBHOOK_URL && process.env.DRIVE_TOKEN);
}

const INTENTOS = 3;
const ESPERAS = [3000, 10000]; // pausa antes del 2.º y 3.er intento
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Fila de llamadas: cada una espera a que termine la anterior
let fila = Promise.resolve();
function enFila(tarea) {
  const p = fila.then(tarea, tarea);
  fila = p.catch(() => {});
  return p;
}

// Una sola llamada al script: POST, seguir la redirección con GET y leer el JSON
async function llamarUnaVez(cuerpo, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    let r = await fetch(process.env.DRIVE_WEBHOOK_URL, {
      method: 'POST', signal: ctrl.signal, redirect: 'manual',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: process.env.DRIVE_TOKEN, ...cuerpo }),
    });
    for (let saltos = 0; r.status >= 300 && r.status < 400 && saltos < 5; saltos++) {
      const destino = r.headers.get('location');
      if (!destino) break;
      r = await fetch(new URL(destino, process.env.DRIVE_WEBHOOK_URL), { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    }
    let texto = await r.text(), j;
    try { j = JSON.parse(texto); } catch {
      // El script ya trabajó; solo falló la lectura del resultado: se vuelve a leer una vez
      if (r.url && r.url !== process.env.DRIVE_WEBHOOK_URL) {
        await espera(1500);
        const r2 = await fetch(r.url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' });
        texto = await r2.text();
        try { j = JSON.parse(texto); } catch { throw new Error(`Google respondió ${r2.status} sin datos`); }
      } else throw new Error(`Google respondió ${r.status} sin datos`);
    }
    if (!j.ok) throw new Error(j.error || `respuesta ${r.status}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Google no respondió en ${Math.round(ms / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Llamada con reintentos, en fila. `etiqueta` sirve para los mensajes del registro.
function llamarScript(cuerpo, ms, etiqueta) {
  return enFila(async () => {
    let ultimo;
    for (let n = 1; n <= INTENTOS; n++) {
      try {
        const j = await llamarUnaVez(cuerpo, ms);
        if (n > 1) console.log(`${etiqueta}: listo en el intento ${n}`);
        return j;
      } catch (e) {
        ultimo = e;
        if (n < INTENTOS) {
          console.log(`${etiqueta}: intento ${n} falló (${e.message}); se reintenta`);
          await espera(ESPERAS[n - 1]);
        }
      }
    }
    throw ultimo;
  });
}

async function guardarEnDrive(nombre, pdf) {
  if (!configurado()) throw new Error('Drive no configurado (faltan DRIVE_WEBHOOK_URL o DRIVE_TOKEN)');
  try {
    const j = await llamarScript({ nombre, pdf: pdf.toString('base64') }, 30000, `Drive ${nombre}`);
    return j.id;
  } catch (e) { throw new Error(`Drive: ${e.message}`); }
}

// Envía a la hoja de Google "Entradas Bodega" un registro (accion "eb_fila") o todos ("eb_todo").
async function enviarHojaEB(datos) {
  if (!configurado()) throw new Error('Drive no configurado (faltan DRIVE_WEBHOOK_URL o DRIVE_TOKEN)');
  const etiqueta = `Hoja ${datos.hoja || 'principal'} ${datos.accion === 'eb_todo' ? '(completa)' : (datos.fila && datos.fila[0]) || ''}`.trim();
  try {
    return await llamarScript(datos, 120000, etiqueta);
  } catch (e) { throw new Error(`Hoja Entradas Bodega: ${e.message}`); }
}

module.exports = { guardarEnDrive, enviarHojaEB, configurado };

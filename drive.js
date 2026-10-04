// Guarda el PDF de cada orden en Google Drive mediante un Google Apps Script (ver apps-script/Code.gs).
function configurado() {
  return !!(process.env.DRIVE_WEBHOOK_URL && process.env.DRIVE_TOKEN);
}

async function guardarEnDrive(nombre, pdf) {
  if (!configurado()) throw new Error('Drive no configurado (faltan DRIVE_WEBHOOK_URL o DRIVE_TOKEN)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(process.env.DRIVE_WEBHOOK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: process.env.DRIVE_TOKEN, nombre, pdf: pdf.toString('base64') }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`Drive: ${j.error || r.status}`);
    return j.id;
  } finally {
    clearTimeout(t);
  }
}

// Envía a la hoja de Google "Entradas Bodega" un registro (accion "eb_fila") o todos ("eb_todo").
async function enviarHojaEB(datos) {
  if (!configurado()) throw new Error('Drive no configurado (faltan DRIVE_WEBHOOK_URL o DRIVE_TOKEN)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(process.env.DRIVE_WEBHOOK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: process.env.DRIVE_TOKEN, ...datos }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`Hoja Entradas Bodega: ${j.error || r.status}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { guardarEnDrive, enviarHojaEB, configurado };

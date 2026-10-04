const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { generarPDF } = require('./pdf');
const { enviarOrden } = require('./mail');
const { formatoOC } = require('./oc');
const { guardarEnDrive, enviarHojaEB, configurado: driveListo } = require('./drive');

const app = express();
app.use(express.json({ limit: '200kb' }));

// --- Limpieza de datos que llegan del formulario ---
const t = (v, max = 200) => String(v ?? '').trim().slice(0, max);
function limpiar(body) {
  const filas = (Array.isArray(body.filas) ? body.filas : []).slice(0, 20).map((f) => ({
    trafico: t(f.trafico, 60),
    bultos: t(f.bultos, 60),
    pedimento: t(f.pedimento, 60),
    nota: t(f.nota, 300),
    separado: !!f.separado,
    cargado: !!f.cargado,
  }));
  return {
    cliente: t(body.cliente),
    caja: t(body.caja),
    sello: t(body.sello),
    fecha: t(body.fecha, 30),
    capturista: t(body.capturista, 80),
    filas,
  };
}

// --- Protección sencilla del panel de administración ---
function admin(req, res, next) {
  const clave = process.env.ADMIN_PASSWORD;
  if (!clave) return res.status(503).send('Falta definir ADMIN_PASSWORD en el servidor.');
  const [tipo, cred] = (req.headers.authorization || '').split(' ');
  if (tipo === 'Basic' && cred) {
    const texto = Buffer.from(cred, 'base64').toString();
    const i = texto.indexOf(':');
    const user = texto.slice(0, i), pass = texto.slice(i + 1);
    const igual = (x, y) => { const a = Buffer.from(x), b = Buffer.from(y); return a.length === b.length && crypto.timingSafeEqual(a, b); };
    const usuario = process.env.ADMIN_USER || 'amedina';
    if (i >= 0 && igual(user, usuario) && igual(pass, clave)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="MEJAnet"').status(401).send('Acceso restringido');
}

// --- Crear órdenes (requiere usuario y contraseña) ---
app.post('/api/ordenes', admin, async (req, res) => {
  try {
    const datos = limpiar(req.body);
    const hayDatos = datos.cliente || datos.filas.some((f) => f.trafico || f.bultos || f.pedimento || f.nota);
    if (!hayDatos) return res.status(400).json({ error: 'La orden está vacía.' });
    const reg = await db.guardar(datos); // aquí se asigna el número de OC consecutivo
    // Se responde de inmediato; el PDF y el correo se procesan en segundo plano.
    res.json({ ok: true, oc: formatoOC(reg.oc) });
    (async () => {
      let pdf;
      try { pdf = await generarPDF(datos, reg.oc); }
      catch (e) { console.error(`Error generando PDF de OC ${formatoOC(reg.oc)}:`, e.message); return; }
      const oc = formatoOC(reg.oc);
      await Promise.all([
        enviarOrden(reg, pdf)
          .then(() => db.marcarCorreo(reg.id, true))
          .catch((e) => console.error(`Error enviando correo de OC ${oc}:`, e.message)),
        driveListo()
          ? guardarEnDrive(`ORDEN_DE_CARGA_${oc}.pdf`, pdf)
              .catch((e) => console.error(`Error guardando OC ${oc} en Drive:`, e.message))
          : null,
      ]);
    })();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar la orden.' });
  }
});

// --- Entradas de bodega ---
const CAMPOS_EB = ['fecha', 'cliente', 'bultos', 'descripcion', 'peso_lbs', 'peso_kgs', 'linea', 'tracking', 'po', 'proveedor', 'pedimento', 'tipo', 'notas', 'revisado'];
const TIPOS_EB = ['', 'IN-BOND'];
const maxEB = (k) => (k === 'notas' ? 500 : 120);
app.get('/entradas-bodega', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'entradas-bodega.html')));
app.get('/entradas-bodega/nueva', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'nueva-entrada-bodega.html')));
app.get('/api/admin/entradas-bodega', admin, async (_req, res) => {
  try { res.json(await db.listarEntradasEB()); } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudieron leer las entradas' }); }
});
// Copia a la hoja de Google "Entradas Bodega" (en segundo plano; si falla solo se anota en el log)
const filaHoja = (referencia, d) => [referencia, ...CAMPOS_EB.map((k) => d[k] ?? '')];
function copiarAHoja(buscar, referencia, datos) {
  if (!driveListo()) return;
  enviarHojaEB({ accion: 'eb_fila', buscar, fila: filaHoja(referencia, datos) })
    .catch((e) => console.error(`No se pudo copiar ${referencia} a la hoja:`, e.message));
}

// Referencia: el usuario escribe ####/## y se guarda como "MEJA ####/##"
function refEB(v) {
  const m = /^\s*(?:MEJA\s*)?(\d{1,4})\s*\/\s*(\d{2})\s*$/i.exec(String(v ?? ''));
  return m ? `MEJA ${m[1].padStart(4, '0')}/${m[2]}` : null;
}
app.post('/api/admin/entradas-bodega', admin, async (req, res) => {
  try {
    const referencia = refEB(req.body.referencia);
    if (!referencia) return res.status(400).json({ error: 'Escribe la referencia con el formato ####/## (por ejemplo 1628/26).' });
    const datos = {};
    for (const k of CAMPOS_EB) datos[k] = t(req.body[k], maxEB(k));
    if (!TIPOS_EB.includes(datos.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    datos.revisado = '';
    if (datos.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    const reg = await db.guardarEntradaEB(referencia, datos);
    res.json({ ok: true, id: reg.id, referencia: reg.referencia });
    copiarAHoja(reg.referencia, reg.referencia, reg.datos);
  } catch (e) {
    if (e instanceof db.RefRepetida) return res.status(409).json({ error: 'Esa referencia ya existe.' });
    console.error(e); res.status(500).json({ error: 'No se pudo guardar el registro.' });
  }
});
// Manda todos los registros a la hoja de Google (reemplaza su contenido)
async function hojaCompleta() {
  const lista = (await db.listarEntradasEB()).sort((a, b) => a.referencia.localeCompare(b.referencia));
  return enviarHojaEB({ accion: 'eb_todo', filas: lista.map((x) => filaHoja(x.referencia, x.datos)) });
}
app.post('/api/admin/entradas-bodega/hoja', admin, async (_req, res) => {
  try {
    if (!driveListo()) return res.status(503).json({ error: 'Falta configurar DRIVE_WEBHOOK_URL y DRIVE_TOKEN en Render.' });
    const r = await hojaCompleta();
    res.json({ ok: true, filas: r.filas });
  } catch (e) { console.error(e); res.status(502).json({ error: e.message }); }
});
// Borrar un registro; después se reescribe la hoja de Google sin él
app.delete('/api/admin/entradas-bodega/:id', admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Datos inválidos' });
    const referencia = await db.borrarEntradaEB(id);
    if (!referencia) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, referencia });
    if (driveListo()) hojaCompleta().catch((e) => console.error(`No se pudo quitar ${referencia} de la hoja:`, e.message));
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudo borrar el registro.' }); }
});
app.put('/api/admin/entradas-bodega/:id', admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Datos inválidos' });
    const cambios = {};
    for (const k of CAMPOS_EB) if (k in req.body) cambios[k] = t(req.body[k], maxEB(k));
    if ('tipo' in cambios && !TIPOS_EB.includes(cambios.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    if ('revisado' in cambios && !['', 'REVISADO'].includes(cambios.revisado)) return res.status(400).json({ error: 'Valor inválido' });
    if ('referencia' in req.body) {
      cambios.referencia = refEB(req.body.referencia);
      if (!cambios.referencia) return res.status(400).json({ error: 'La referencia debe tener el formato ####/##.' });
    }
    if (cambios.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(cambios.fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Sin cambios' });
    const antes = (await db.listarEntradasEB()).find((x) => x.id === id);
    const reg = await db.actualizarEntradaEB(id, cambios);
    if (!reg) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, ...reg });
    copiarAHoja(antes ? antes.referencia : reg.referencia, reg.referencia, reg.datos);
  } catch (e) {
    if (e instanceof db.RefRepetida) return res.status(409).json({ error: 'Esa referencia ya existe.' });
    console.error(e); res.status(500).json({ error: 'No se pudo guardar el cambio.' });
  }
});

// --- Rutas del administrador ---
app.get('/orden-de-carga', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/ordenes-completadas', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/nueva-orden', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'nueva-orden.html')));
app.get('/admin', (_req, res) => res.redirect('/orden-de-carga'));
// Resultado de la revisión de OC_TERMINADAS (lo escribe la tarea de revisión en Drive; se lee vía Apps Script).
let cacheTerm = { t: 0, data: null };
// Pide el resultado al Apps Script. Si Google contesta con una página de error (HTML) en vez de JSON, lanza error.
async function leerTerminadas(url, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${url}?token=${encodeURIComponent(token)}`, { signal: ctrl.signal, redirect: 'follow' });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); }
    catch { throw new Error(`Google respondió ${r.status} sin datos: ${txt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`); }
    if (!j.ok) throw new Error(j.error || 'respuesta inválida');
    return { archivos: j.archivos || [], actualizado: j.actualizado };
  } finally {
    clearTimeout(t);
  }
}
app.get('/api/admin/terminadas', admin, async (_req, res) => {
  if (cacheTerm.data && Date.now() - cacheTerm.t < 60000) return res.json(cacheTerm.data);
  const url = process.env.DRIVE_WEBHOOK_URL, token = process.env.DRIVE_TOKEN;
  if (!url || !token) return res.json({ archivos: [], error: 'Drive no configurado' });
  let ultimoError;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      cacheTerm = { t: Date.now(), data: await leerTerminadas(url, token) };
      return res.json(cacheTerm.data);
    } catch (e) {
      ultimoError = e;
      console.error(`Error leyendo OC_TERMINADAS (intento ${intento}):`, e.message);
      if (intento === 1) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // Si ya se había leído antes, se muestra lo último que se obtuvo bien
  if (cacheTerm.data) return res.json({ ...cacheTerm.data, aviso: 'Se muestra el último estado de escaneo leído; Google no respondió en este momento.' });
  res.json({ archivos: [], error: ultimoError.message.startsWith('Google respondió') ? 'Google no respondió en este momento, intenta recargar' : ultimoError.message });
});

// Cambiar a mano si un tráfico está separado / cargado (valor null = quitar el cambio manual)
app.put('/api/admin/ordenes/:id/estado', admin, async (req, res) => {
  try {
    const id = Number(req.params.id), n = Number(req.body.n), campo = req.body.campo, valor = req.body.valor;
    if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || n > 20 ||
        !['separado', 'cargado'].includes(campo) || !(valor === null || typeof valor === 'boolean')) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const manual = await db.cambiarManual(id, String(n), campo, valor);
    if (!manual) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true, manual });
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudo guardar' }); }
});

app.get('/api/admin/ordenes', admin, async (_req, res) => res.json(await db.listar()));
app.get('/api/admin/ordenes/:id/pdf', admin, async (req, res) => {
  const reg = await db.obtener(Number(req.params.id));
  if (!reg) return res.status(404).send('No encontrada');
  res.type('pdf').set('Content-Disposition', `inline; filename="ORDEN_DE_CARGA_${formatoOC(reg.oc)}.pdf"`)
     .send(await generarPDF(reg.datos, reg.oc));
});

app.use(express.static(path.join(__dirname, 'public')));

const puerto = process.env.PORT || 3000;
db.init().then(() => app.listen(puerto, () => console.log('Escuchando en puerto', puerto)))
  .catch((e) => { console.error('No se pudo iniciar la base de datos:', e); process.exit(1); });

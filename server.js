const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { generarPDF } = require('./pdf');
const { enviarOrden } = require('./mail');
const { formatoOC } = require('./oc');
const { guardarEnDrive, enviarHojaEB, configurado: driveListo } = require('./drive');
const cotizador = require('./cotizador');

const app = express();
app.set('trust proxy', 1); // Render pasa por un proxy; así req.ip es la IP real del visitante
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

// --- Inicio de sesión (página principal /) y protección de todas las secciones ---
// Al entrar con usuario y contraseña se guarda una cookie firmada que dura 1 año
// (se renueva sola en cada visita), así que el navegador ya no vuelve a pedir credenciales.
// Usuarios: ADMIN_USER / ADMIN_PASSWORD, más los de la variable USUARIOS en Render,
// con el formato  usuario:contraseña,usuario2:contraseña2  (el usuario distingue mayúsculas).
// Si se cambia la contraseña de un usuario, sus sesiones abiertas se cierran; SESSION_SECRET las cierra todas.
const COOKIE = 'mejanet_sesion';
const DURACION_SESION = 365 * 24 * 60 * 60 * 1000; // 1 año
function usuarios() {
  const lista = new Map();
  for (const par of String(process.env.USUARIOS || '').split(/[,\n]/)) {
    const i = par.indexOf(':');
    const u = par.slice(0, i).trim(), c = par.slice(i + 1).trim();
    if (i > 0 && u && c) lista.set(u, c);
  }
  if (process.env.ADMIN_PASSWORD) lista.set(process.env.ADMIN_USER || 'amedina', process.env.ADMIN_PASSWORD);
  return lista;
}
const igual = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const firma = (usuario, clave, texto) => crypto.createHmac('sha256', `${process.env.SESSION_SECRET || ''}|${clave}|${usuario}`)
  .update(texto).digest('base64url');
function crearSesion(res, usuario, clave) {
  const vence = Date.now() + DURACION_SESION;
  const datos = `${Buffer.from(usuario).toString('base64url')}.${vence}`;
  res.cookie(COOKIE, `${datos}.${firma(usuario, clave, datos)}`, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' || !!process.env.RENDER,
    maxAge: DURACION_SESION, path: '/',
  });
}
function leerCookie(req) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === COOKIE) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return '';
}
// Devuelve el usuario de la sesión, o null si no hay sesión válida
function sesionValida(req) {
  const [u, vence, f] = leerCookie(req).split('.');
  if (!u || !vence || !f || !(Number(vence) > Date.now())) return null;
  const usuario = Buffer.from(u, 'base64url').toString();
  const clave = usuarios().get(usuario);
  return clave && igual(f, firma(usuario, clave, `${u}.${vence}`)) ? usuario : null;
}
function admin(req, res, next) {
  if (!usuarios().size) return res.status(503).send('Falta definir ADMIN_PASSWORD en el servidor.');
  const usuario = sesionValida(req);
  if (usuario) {
    req.usuario = usuario;
    crearSesion(res, usuario, usuarios().get(usuario)); // renueva el año de vigencia
    return next();
  }
  // Páginas: se manda a la pantalla de inicio de sesión; API: error 401
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    const next_ = req.originalUrl === '/modulos' ? '' : `?next=${encodeURIComponent(req.originalUrl)}`;
    return res.redirect(`/${next_}`);
  }
  res.status(401).json({ error: 'Tu sesión terminó. Vuelve a iniciar sesión.' });
}

// Página principal (mejanet.onrender.com): inicio de sesión. Con sesión activa pasa directo a Módulos.
app.get(['/', '/index.html'], (req, res) => {
  if (sesionValida(req)) return res.redirect('/modulos');
  res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'admin', 'login.html'));
});
app.get('/login', (req, res) => res.redirect('/' + (req.query.next ? `?next=${encodeURIComponent(req.query.next)}` : '')));
const intentos = new Map(); // freno sencillo contra adivinar la contraseña: 10 intentos fallidos por IP cada 15 min
app.post('/api/login', (req, res) => {
  const lista = usuarios();
  if (!lista.size) return res.status(503).json({ error: 'Falta definir ADMIN_PASSWORD en el servidor.' });
  const ip = req.ip, ahora = Date.now();
  const reg = intentos.get(ip);
  if (reg && ahora - reg.desde < 15 * 60 * 1000 && reg.n >= 10)
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' });
  const usuario = t(req.body && req.body.usuario, 100), clave = String((req.body && req.body.clave) ?? '').slice(0, 200);
  const correcta = lista.get(usuario);
  if (correcta && igual(clave, correcta)) {
    intentos.delete(ip);
    crearSesion(res, usuario, correcta);
    return res.json({ ok: true });
  }
  if (!reg || ahora - reg.desde >= 15 * 60 * 1000) intentos.set(ip, { desde: ahora, n: 1 });
  else reg.n++;
  res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
});
app.get('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/');
});

// Módulos (logo y botones), después de iniciar sesión
app.get('/modulos', admin, (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'admin', 'modulos.html')));

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
const CAMPOS_EB = ['fecha', 'cliente', 'bultos', 'descripcion', 'peso_lbs', 'peso_kgs', 'linea', 'tracking', 'po', 'proveedor', 'pedimento', 'tipo', 'notas', 'revisado', 'hazmat'];
const TIPOS_EB = ['', 'IN-BOND'];
const maxEB = (k) => (k === 'notas' ? 500 : 120);
app.get('/entradas-bodega', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'entradas-bodega.html')));
app.get('/entradas-bodega/nueva', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'nueva-entrada-bodega.html')));
app.get('/api/admin/entradas-bodega', admin, async (_req, res) => {
  try { res.json(await db.listarEntradasEB()); } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudieron leer las entradas' }); }
});
// Copia a la hoja de Google "Entradas Bodega" (en segundo plano; si falla solo se anota en el log)
const filaHoja = (referencia, d) => [referencia, ...CAMPOS_EB.map((k) => d[k] ?? '')];
// Clientes que además se copian a la hoja "FEVISA 2026"
const CLIENTES_FEVISA = ['FABRICA', 'MAQUINARIA', 'FEVISA'];
// Basta con que el nombre del cliente contenga alguno de los tres (p. ej. "FABRICA A3").
const esFevisa = (d) => {
  const c = String((d && d.cliente) || '').toUpperCase();
  return CLIENTES_FEVISA.some((n) => c.includes(n));
};
async function hojaCompletaFevisa() {
  const lista = (await db.listarEntradasEB()).filter((x) => esFevisa(x.datos)).sort((a, b) => a.referencia.localeCompare(b.referencia));
  return enviarHojaEB({ accion: 'eb_todo', hoja: 'fevisa', filas: lista.map((x) => filaHoja(x.referencia, x.datos)) });
}
// Mantiene al día la hoja FEVISA según el registro antes y después del cambio (null si no existía / se borró)
function copiarAFevisa(antes, despues) {
  if (!driveListo() || !(esFevisa(antes && antes.datos) || esFevisa(despues && despues.datos))) return;
  const p = (esFevisa(antes && antes.datos) || !antes) && despues && esFevisa(despues.datos)
    ? enviarHojaEB({ accion: 'eb_fila', hoja: 'fevisa', buscar: antes ? antes.referencia : despues.referencia, fila: filaHoja(despues.referencia, despues.datos) })
    : hojaCompletaFevisa(); // entró o salió de la lista (cambio de cliente o borrado): se reescribe la hoja
  p.catch((e) => console.error('No se pudo actualizar la hoja FEVISA:', e.message));
}
function copiarAHoja(buscar, referencia, datos) {
  if (!driveListo()) return;
  enviarHojaEB({ accion: 'eb_fila', buscar, fila: filaHoja(referencia, datos) })
    .catch((e) => console.error(`No se pudo copiar ${referencia} a la hoja:`, e.message));
}

// Referencia: el usuario escribe ####/## y se guarda como "MEJA ####/##"
function refEB(v) {
  // ####/### : número, año de 2 dígitos y, si aplica, una letra o dígito extra (p. ej. 0212/26A)
  const m = /^\s*(?:MEJA\s*)?(\d{1,4})\s*\/\s*(\d{2}[A-Z0-9]?)\s*$/i.exec(String(v ?? ''));
  return m ? `MEJA ${m[1].padStart(4, '0')}/${m[2].toUpperCase()}` : null;
}
app.post('/api/admin/entradas-bodega', admin, async (req, res) => {
  try {
    const referencia = refEB(req.body.referencia);
    if (!referencia) return res.status(400).json({ error: 'Escribe la referencia con el formato ####/### (por ejemplo 1628/26 o 1628/26A).' });
    const datos = {};
    for (const k of CAMPOS_EB) datos[k] = t(req.body[k], maxEB(k));
    if (!TIPOS_EB.includes(datos.tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    datos.revisado = '';
    if (!['', 'HAZ-MAT'].includes(datos.hazmat)) return res.status(400).json({ error: 'Valor inválido' });
    if (datos.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    db.reglaA3F4(datos); // clientes A3 / F4: REVISADO y pedimento N/A
    const reg = await db.guardarEntradaEB(referencia, datos);
    res.json({ ok: true, id: reg.id, referencia: reg.referencia });
    copiarAHoja(reg.referencia, reg.referencia, reg.datos);
    copiarAFevisa(null, reg);
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
app.post('/api/admin/entradas-bodega/hoja-fevisa', admin, async (_req, res) => {
  try {
    if (!driveListo()) return res.status(503).json({ error: 'Falta configurar DRIVE_WEBHOOK_URL y DRIVE_TOKEN en Render.' });
    const r = await hojaCompletaFevisa();
    res.json({ ok: true, filas: r.filas });
  } catch (e) { console.error(e); res.status(502).json({ error: e.message }); }
});
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
    const antes = (await db.listarEntradasEB()).find((x) => x.id === id);
    const referencia = await db.borrarEntradaEB(id);
    if (!referencia) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, referencia });
    if (driveListo()) hojaCompleta().catch((e) => console.error(`No se pudo quitar ${referencia} de la hoja:`, e.message));
    copiarAFevisa(antes, null);
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
    if ('hazmat' in cambios && !['', 'HAZ-MAT'].includes(cambios.hazmat)) return res.status(400).json({ error: 'Valor inválido' });
    if ('referencia' in req.body) {
      cambios.referencia = refEB(req.body.referencia);
      if (!cambios.referencia) return res.status(400).json({ error: 'La referencia debe tener el formato ####/###.' });
    }
    if (cambios.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(cambios.fecha)) return res.status(400).json({ error: 'Fecha inválida' });
    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Sin cambios' });
    const antes = (await db.listarEntradasEB()).find((x) => x.id === id);
    // Clientes A3 / F4: siempre REVISADO y, si no hay pedimento, N/A
    if (antes) {
      const { referencia: _r, ...soloDatos } = cambios;
      const final = db.reglaA3F4({ ...antes.datos, ...soloDatos });
      for (const k of ['revisado', 'pedimento']) if (k in cambios || final[k] !== (antes.datos[k] ?? '')) cambios[k] = final[k];
    }
    const reg = await db.actualizarEntradaEB(id, cambios);
    if (!reg) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, ...reg });
    copiarAHoja(antes ? antes.referencia : reg.referencia, reg.referencia, reg.datos);
    copiarAFevisa(antes || reg, reg);
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

// --- Cotizador ---
app.use(cotizador.rutas(admin));

app.use(express.static(path.join(__dirname, 'public')));

const puerto = process.env.PORT || 3000;
db.init().then(async (aplicadas) => {
  await cotizador.init();
  app.listen(puerto, () => console.log('Escuchando en puerto', puerto));
  // Si un cambio de datos se aplicó al arrancar, se actualiza la hoja de Google completa
  if (Array.isArray(aplicadas) && aplicadas.length && driveListo()) {
    hojaCompleta().then((r) => console.log(`Hoja de Google actualizada: ${r.filas} registros`))
      .catch((e) => console.error('No se pudo actualizar la hoja tras la migración:', e.message));
    hojaCompletaFevisa().then((r) => console.log(`Hoja FEVISA actualizada: ${r.filas} registros`))
      .catch((e) => console.error('No se pudo actualizar la hoja FEVISA tras la migración:', e.message));
  }
})
  .catch((e) => { console.error('No se pudo iniciar la base de datos:', e); process.exit(1); });

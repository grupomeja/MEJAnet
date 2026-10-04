const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { generarPDF } = require('./pdf');
const { enviarOrden } = require('./mail');
const { formatoOC } = require('./oc');

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
    const pass = Buffer.from(cred, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(clave);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Administracion"').status(401).send('Acceso restringido');
}

// --- Rutas para los trabajadores (sin contraseña) ---
// Cada vez que alguien abre la página se le reserva un número de OC nuevo.
app.get('/api/siguiente', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ oc: await db.reservarOC() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'No disponible' }); }
});

app.post('/api/ordenes', async (req, res) => {
  try {
    const datos = limpiar(req.body);
    const hayDatos = datos.cliente || datos.filas.some((f) => f.trafico || f.bultos || f.pedimento || f.nota);
    if (!hayDatos) return res.status(400).json({ error: 'La orden está vacía.' });
    // Usa el número reservado al abrir la página; si falta, es inválido o ya se usó, se asigna uno nuevo.
    let oc = Number.parseInt(req.body.oc, 10);
    const valido = Number.isInteger(oc) && oc >= 1 && oc <= (await db.ultimoOCEmitido()) && !(await db.existeOC(oc));
    if (!valido) oc = await db.reservarOC();
    let reg;
    try { reg = await db.guardar(datos, oc); }
    catch (e) {
      if (e.code !== '23505') throw e;           // OC repetida por una carrera: se asigna otra
      reg = await db.guardar(datos, await db.reservarOC());
    }
    let correo = false;
    try {
      correo = await enviarOrden(reg, await generarPDF(datos, reg.oc));
    } catch (e) {
      console.error('Error enviando correo:', e.message);
    }
    res.json({ ok: true, oc: formatoOC(reg.oc), correo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar la orden.' });
  }
});

// --- Rutas del administrador ---
app.get('/admin', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
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

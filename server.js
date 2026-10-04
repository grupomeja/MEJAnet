const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { generarPDF } = require('./pdf');
const { enviarOrden } = require('./mail');
const { formatoOC } = require('./oc');
const { guardarEnDrive, configurado: driveListo } = require('./drive');

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

// --- Rutas del administrador ---
app.get('/orden-de-carga', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/nueva-orden', admin, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'nueva-orden.html')));
app.get('/admin', (_req, res) => res.redirect('/orden-de-carga'));
// Resultado de la revisión de OC_TERMINADAS (lo escribe la tarea de revisión en Drive; se lee vía Apps Script).
let cacheTerm = { t: 0, data: null };
app.get('/api/admin/terminadas', admin, async (_req, res) => {
  if (cacheTerm.data && Date.now() - cacheTerm.t < 60000) return res.json(cacheTerm.data);
  const url = process.env.DRIVE_WEBHOOK_URL, token = process.env.DRIVE_TOKEN;
  if (!url || !token) return res.json({ archivos: [], error: 'Drive no configurado' });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${url}?token=${encodeURIComponent(token)}`, { signal: ctrl.signal, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'respuesta inválida');
    cacheTerm = { t: Date.now(), data: { archivos: j.archivos || [], actualizado: j.actualizado } };
    res.json(cacheTerm.data);
  } catch (e) {
    console.error('Error leyendo OC_TERMINADAS:', e.message);
    res.json({ archivos: [], error: e.message });
  } finally {
    clearTimeout(t);
  }
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

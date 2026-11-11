// Cajas en patio: registro de cajas (remolques) con foto de la caja y de la placa.
// Se guarda en Postgres (si hay DATABASE_URL) o en archivos JSON locales, igual que el resto de MEJAnet.
// Las fotos llegan ya reducidas desde la página (JPEG de ~1280 px) y se guardan aparte de los datos,
// para que la lista cargue rápido sin traer las fotos.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');

const pool = db.pool;
const FILE = path.join(db.DIR, 'cajas_patio.json');
const FILE_L = path.join(db.DIR, 'cajas_lineas.json');
const DIR_F = path.join(db.DIR, 'cajas_fotos');

// Líneas transportistas iniciales (hoja SCAC del Excel REPORTE CAJA)
const LINEAS_INICIO = [
  ['TZYA', 'TRANSPORTES ZENTRY', '1PWT'], ['TSMV', 'TSM CONNECT', ''], ['CHJO', 'CHJ TRANSPORT', '33MK'], ['SSZB', 'SE TRANSPORTES', '3H2W'],
  ['TRER', 'TRANSPORTES ROI', '2Z6E'], ['TRKP', 'ALZA TRANSPORTE', '3MAI'], ['ROQN', 'TRANSPORTES ROSALES', '3LOS'], ['AMDH', "AMADOR'S TRUCKING", '1D59'],
  ['TXEE', 'TRANSPORTES ENLACE', '10B2'], ['EGLP', 'ESPECIALIZADOS LOPEZ', '10PO'], ['FMSR', 'FLETES MUSA', '31BP'], ['ETPW', 'ESBOR TRANSFER', '3K98'],
  ['GZXP', 'GONZALEZ EXPRESS', '2HHO'], ['TTRO', 'TRINIDAD TRANSFER', '3ECZ'], ['CFWY', 'CRUCES FRONTERIZOS EXPRESS', '3N1S'], ['TMUM', 'TRANSPORTES MAG', '1ATZ'],
  ['HLUK', 'HELU TRUCKING', '36T8'], ['TANF', 'TRANSLAREDO', '2973'], ['CINL', 'CRUCES IN. MARTINEZ', '1098'], ['RGZL', 'RAGZA', '340H'],
].map(([scac, nombre, caat]) => ({ scac, nombre, caat }));

const ORIGENES = ['MEX', 'USA'];
const ESTATUS = ['CARGADA', 'VACIA'];
const UBICACIONES = ['PATIO', 'ANDEN'];

const txt = (v, max = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
const leerJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const escribirJSON = (f, x) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(x)); };

// Foto: data URL JPEG/PNG/WebP de hasta ~3 MB
function foto(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || !v) return undefined;
  const m = v.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw Object.assign(new Error('La foto no es una imagen válida.'), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw Object.assign(new Error('La foto es demasiado grande.'), { status: 400 });
  return { tipo: 'image/' + m[1], buf };
}

// Datos de una caja a partir de lo que manda la página
function datos(b) {
  const d = {
    linea: txt(b?.linea, 80),
    scac: txt(b?.scac, 8),
    caja: txt(b?.caja, 30),
    placa: txt(b?.placa, 20),
    origen: ORIGENES.includes(txt(b?.origen)) ? txt(b?.origen) : '',
    medida: txt(b?.medida, 10),
    meja: txt(b?.meja, 30),
    estatus: ESTATUS.includes(txt(b?.estatus)) ? txt(b?.estatus) : '',
    ubicacion: UBICACIONES.includes(txt(b?.ubicacion)) ? txt(b?.ubicacion) : '',
    notas: String(b?.notas ?? '').trim().slice(0, 500),
  };
  if (!d.caja) throw Object.assign(new Error('Falta el número de caja.'), { status: 400 });
  return d;
}

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS cajas_patio (
      id SERIAL PRIMARY KEY,
      datos JSONB NOT NULL,
      llegada TIMESTAMPTZ NOT NULL DEFAULT now(),
      salida TIMESTAMPTZ,
      creado_por TEXT,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_por TEXT,
      salida_por TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cajas_patio_fotos (
      caja_id INTEGER NOT NULL REFERENCES cajas_patio(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      mime TEXT NOT NULL,
      img BYTEA NOT NULL,
      PRIMARY KEY (caja_id, tipo)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cajas_lineas (
      scac TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      caat TEXT
    )`);
    const n = await pool.query('SELECT count(*)::int AS n FROM cajas_lineas');
    if (!n.rows[0].n) for (const l of LINEAS_INICIO) await pool.query('INSERT INTO cajas_lineas (scac, nombre, caat) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [l.scac, l.nombre, l.caat]);
  } else {
    if (!fs.existsSync(FILE)) escribirJSON(FILE, []);
    if (!fs.existsSync(FILE_L)) escribirJSON(FILE_L, LINEAS_INICIO);
  }
}

// --- Acceso a datos ---
async function listar() {
  if (pool) {
    const r = await pool.query(`SELECT c.id, c.datos, c.llegada, c.salida, c.creado_por, c.actualizado, c.actualizado_por, c.salida_por,
      COALESCE(array_agg(f.tipo) FILTER (WHERE f.tipo IS NOT NULL), '{}') AS fotos
      FROM cajas_patio c LEFT JOIN cajas_patio_fotos f ON f.caja_id = c.id
      GROUP BY c.id ORDER BY c.salida IS NOT NULL, COALESCE(c.salida, c.llegada) DESC`);
    return r.rows;
  }
  return leerJSON(FILE, []).map(({ ...c }) => c).sort((a, b) => (!!a.salida - !!b.salida) || String(b.salida || b.llegada).localeCompare(String(a.salida || a.llegada)));
}
async function crear(d, fotos, usuario) {
  if (pool) {
    const r = await pool.query('INSERT INTO cajas_patio (datos, creado_por, actualizado_por) VALUES ($1, $2, $2) RETURNING id, llegada', [d, usuario || null]);
    const id = r.rows[0].id;
    await guardarFotos(id, fotos);
    return { id, llegada: r.rows[0].llegada };
  }
  const xs = leerJSON(FILE, []);
  const id = xs.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const ahora = new Date().toISOString();
  xs.push({ id, datos: d, llegada: ahora, salida: null, creado_por: usuario || null, actualizado: ahora, actualizado_por: usuario || null, fotos: [] });
  escribirJSON(FILE, xs);
  await guardarFotos(id, fotos);
  return { id, llegada: ahora };
}
async function actualizar(id, cambios, fotos, usuario) {
  if (pool) {
    const sets = ['actualizado = now()', 'actualizado_por = $2'], vals = [id, usuario || null];
    if (cambios.datos) { vals.push(cambios.datos); sets.push('datos = $' + vals.length); }
    if ('salida' in cambios) { sets.push(cambios.salida ? 'salida = now(), salida_por = $2' : 'salida = NULL, salida_por = NULL'); }
    const r = await pool.query(`UPDATE cajas_patio SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
    if (!r.rowCount) return false;
    await guardarFotos(id, fotos);
    return true;
  }
  const xs = leerJSON(FILE, []);
  const c = xs.find((x) => x.id === id);
  if (!c) return false;
  const ahora = new Date().toISOString();
  if (cambios.datos) c.datos = cambios.datos;
  if ('salida' in cambios) { c.salida = cambios.salida ? ahora : null; c.salida_por = cambios.salida ? usuario || null : null; }
  c.actualizado = ahora; c.actualizado_por = usuario || null;
  escribirJSON(FILE, xs);
  await guardarFotos(id, fotos);
  return true;
}
async function borrar(id) {
  if (pool) return (await pool.query('DELETE FROM cajas_patio WHERE id = $1', [id])).rowCount > 0;
  const xs = leerJSON(FILE, []);
  const i = xs.findIndex((x) => x.id === id);
  if (i < 0) return false;
  xs.splice(i, 1);
  escribirJSON(FILE, xs);
  for (const t of ['caja', 'placa']) fs.rmSync(path.join(DIR_F, id + '-' + t), { force: true });
  return true;
}
// fotos = { caja: {tipo, buf} | null (quitar) | undefined (sin cambio), placa: ... }
async function guardarFotos(id, fotos) {
  for (const t of ['caja', 'placa']) {
    const f = fotos[t];
    if (f === undefined) continue;
    if (pool) {
      if (f === null) await pool.query('DELETE FROM cajas_patio_fotos WHERE caja_id = $1 AND tipo = $2', [id, t]);
      else await pool.query(`INSERT INTO cajas_patio_fotos (caja_id, tipo, mime, img) VALUES ($1, $2, $3, $4)
        ON CONFLICT (caja_id, tipo) DO UPDATE SET mime = EXCLUDED.mime, img = EXCLUDED.img`, [id, t, f.tipo, f.buf]);
      continue;
    }
    const file = path.join(DIR_F, id + '-' + t);
    if (f === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(DIR_F, { recursive: true }); fs.writeFileSync(file, Buffer.concat([Buffer.from(f.tipo + '\n'), f.buf])); }
    const xs = leerJSON(FILE, []);
    const c = xs.find((x) => x.id === id);
    if (c) { c.fotos = ['caja', 'placa'].filter((k) => fs.existsSync(path.join(DIR_F, id + '-' + k))); escribirJSON(FILE, xs); }
  }
}
async function leerFoto(id, t) {
  if (pool) {
    const r = await pool.query('SELECT mime, img FROM cajas_patio_fotos WHERE caja_id = $1 AND tipo = $2', [id, t]);
    return r.rows[0] ? { tipo: r.rows[0].mime, buf: r.rows[0].img } : null;
  }
  try {
    const b = fs.readFileSync(path.join(DIR_F, id + '-' + t));
    const i = b.indexOf(10);
    return { tipo: b.slice(0, i).toString(), buf: b.slice(i + 1) };
  } catch { return null; }
}
async function lineas() {
  if (pool) return (await pool.query('SELECT scac, nombre, caat FROM cajas_lineas ORDER BY nombre')).rows;
  return leerJSON(FILE_L, LINEAS_INICIO).sort((a, b) => a.nombre.localeCompare(b.nombre));
}
async function agregarLinea(l) {
  if (pool) {
    await pool.query(`INSERT INTO cajas_lineas (scac, nombre, caat) VALUES ($1, $2, $3)
      ON CONFLICT (scac) DO UPDATE SET nombre = EXCLUDED.nombre, caat = COALESCE(NULLIF(EXCLUDED.caat, ''), cajas_lineas.caat)`, [l.scac, l.nombre, l.caat]);
    return;
  }
  const xs = leerJSON(FILE_L, LINEAS_INICIO).filter((x) => x.scac !== l.scac);
  xs.push(l);
  escribirJSON(FILE_L, xs);
}

function rutas(admin) {
  const r = express.Router();
  const json = express.json({ limit: '8mb' });
  const error = (res, e, msg) => {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: msg });
  };
  const fotosDe = (b) => ({ caja: foto(b?.fotoCaja), placa: foto(b?.fotoPlaca) });

  r.get('/api/cajas', admin, async (_req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ cajas: await listar(), lineas: await lineas() }); }
    catch (e) { error(res, e, 'No se pudo leer la lista de cajas.'); }
  });
  r.post('/api/cajas', admin, json, async (req, res) => {
    try {
      const d = datos(req.body);
      // Si la línea es nueva (con SCAC), se agrega al catálogo
      if (d.scac && d.linea && !(await lineas()).some((l) => l.scac === d.scac)) await agregarLinea({ scac: d.scac, nombre: d.linea, caat: txt(req.body?.caat, 10) });
      res.json(await crear(d, fotosDe(req.body), req.usuario));
    } catch (e) { error(res, e, 'No se pudo guardar la caja.'); }
  });
  r.put('/api/cajas/:id', admin, json, async (req, res) => {
    try {
      const cambios = {};
      if (req.body?.datos) {
        cambios.datos = datos(req.body.datos);
        const d = cambios.datos;
        if (d.scac && d.linea && !(await lineas()).some((l) => l.scac === d.scac)) await agregarLinea({ scac: d.scac, nombre: d.linea, caat: txt(req.body?.caat, 10) });
      }
      if ('salida' in (req.body || {})) cambios.salida = !!req.body.salida;
      const ok = await actualizar(Number(req.params.id), cambios, fotosDe(req.body), req.usuario);
      if (!ok) return res.status(404).json({ error: 'La caja ya no existe.' });
      res.json({ ok: true });
    } catch (e) { error(res, e, 'No se pudo guardar el cambio.'); }
  });
  r.delete('/api/cajas/:id', admin, async (req, res) => {
    try {
      if (!(await borrar(Number(req.params.id)))) return res.status(404).json({ error: 'La caja ya no existe.' });
      res.json({ ok: true });
    } catch (e) { error(res, e, 'No se pudo borrar la caja.'); }
  });
  r.get('/api/cajas/:id/foto/:tipo', admin, async (req, res) => {
    try {
      if (!['caja', 'placa'].includes(req.params.tipo)) return res.status(404).end();
      const f = await leerFoto(Number(req.params.id), req.params.tipo);
      if (!f) return res.status(404).end();
      res.set('Content-Type', f.tipo).set('Cache-Control', 'private, max-age=86400').send(f.buf);
    } catch (e) { error(res, e, 'No se pudo leer la foto.'); }
  });
  return r;
}

module.exports = { init, rutas };

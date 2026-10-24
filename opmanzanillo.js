// OP Manzanillo: seguimiento de operaciones marítimas por el puerto de Manzanillo.
// Un registro por embarque (referencia) con sus datos, hitos (estimada / confirmada / real) y gastos.
// Se guarda en Postgres (si hay DATABASE_URL) o en un archivo JSON local, igual que el resto de MEJAnet.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const { limpiarPrevio, generarPrevio } = require('./previo-pdf');

const pool = db.pool;
const FILE = path.join(db.DIR, 'op_manzanillo.json');
const SEED = path.join(__dirname, 'seed', 'op_manzanillo.json'); // carga inicial desde el Excel "REPORTE DE DESPACHOS"

const HITOS = ['zarpe', 'arribo', 'revalidacion', 'previo', 'despacho', 'retiro'];
const TEXTO = ['ref', 'operacion', 'cliente', 'buque', 'viaje', 'bandera', 'hbl', 'mbl', 'ff', 'tipo', 'previo', 'mercancia', 'marca', 'factura',
  'contenedores', 'terminal', 'claveCR', 'pedimento', 'semaforo', 'estado', 'nota', 'origen', 'origen_puerto', 'creado'];
const NUM = ['peso', 'bultos', 'diasLibres'];
const BOOL = ['pedimentoPagado'];

const leer = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const escribir = (o) => { fs.mkdirSync(db.DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o)); };

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS op_manzanillo (
      id TEXT PRIMARY KEY,
      datos JSONB NOT NULL,
      actualizada TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM op_manzanillo')).rows[0].n;
    if (!n && fs.existsSync(SEED)) {
      const semilla = JSON.parse(fs.readFileSync(SEED, 'utf8'));
      for (const [id, d] of Object.entries(semilla))
        await pool.query('INSERT INTO op_manzanillo (id, datos) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, d]);
      console.log(`OP Manzanillo: ${Object.keys(semilla).length} embarques cargados del Excel`);
    }
  } else if (!fs.existsSync(FILE) && fs.existsSync(SEED)) {
    escribir(JSON.parse(fs.readFileSync(SEED, 'utf8')));
  }
  await sinConfirmada();
  await hitosNuevos();
}

// Hitos de 6 pasos: zarpe, arribo, revalidación, previo, despacho y retiro.
// "Inicio de despacho" y "Conclusión de despacho" se juntan en "Despacho": la fecha estimada sale del
// inicio (programación) y la real de la conclusión. "Disponibilidad de carga" y "Liberación" se quitan.
const VIEJOS = ['desp_ini', 'desp_fin', 'disponible', 'liberacion'];
function aHitosNuevos(d) {
  const h = d.hitos || {};
  if (!VIEJOS.some((k) => k in h)) return false;
  const ini = h.desp_ini || {}, fin = h.desp_fin || {}, ya = h.despacho || {};
  const desp = { e: ya.e || ini.e || fin.e || '', r: ya.r || fin.r || '' };
  if (ya.hora || ini.hora) desp.hora = ya.hora || ini.hora;
  h.despacho = desp;
  for (const k of VIEJOS) delete h[k];
  d.hitos = h;
  return true;
}
async function hitosNuevos() {
  if (pool) {
    const r = await pool.query("SELECT id, datos FROM op_manzanillo WHERE jsonb_path_exists(datos, '$.hitos.desp_ini') OR jsonb_path_exists(datos, '$.hitos.desp_fin') OR jsonb_path_exists(datos, '$.hitos.disponible') OR jsonb_path_exists(datos, '$.hitos.liberacion')");
    for (const row of r.rows) if (aHitosNuevos(row.datos)) await pool.query('UPDATE op_manzanillo SET datos = $2 WHERE id = $1', [row.id, row.datos]);
    if (r.rowCount) console.log(`OP Manzanillo: hitos pasados al nuevo esquema en ${r.rowCount} embarques`);
    return;
  }
  const o = leer(); let n = 0;
  for (const d of Object.values(o)) if (aHitosNuevos(d)) n++;
  if (n) escribir(o);
}

// Ya no se usa la fecha "confirmada": si un hito la tiene, pasa a ser la fecha estimada
// (cuando no había estimada) y se quita. Solo cambia registros que todavía la traen.
function quitarConfirmada(d) {
  let cambio = false;
  for (const h of Object.values(d.hitos || {})) {
    if (h && typeof h === 'object' && 'c' in h) {
      if (h.c && !h.e) h.e = h.c;
      delete h.c; cambio = true;
    }
  }
  return cambio;
}
async function sinConfirmada() {
  if (pool) {
    const r = await pool.query("SELECT id, datos FROM op_manzanillo WHERE jsonb_path_exists(datos, '$.hitos.*.c')");
    for (const row of r.rows) if (quitarConfirmada(row.datos)) await pool.query('UPDATE op_manzanillo SET datos = $2 WHERE id = $1', [row.id, row.datos]);
    if (r.rowCount) console.log(`OP Manzanillo: fecha confirmada pasada a estimada en ${r.rowCount} embarques`);
    return;
  }
  const o = leer(); let n = 0;
  for (const d of Object.values(o)) if (quitarConfirmada(d)) n++;
  if (n) escribir(o);
}

// ---------- Limpieza ----------
const t = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
function limpiarHito(h) {
  const o = {};
  for (const k of ['e', 'r']) if (k in h) o[k] = fecha(h[k]);
  if ('hora' in h) o.hora = t(h.hora, 10);
  return o;
}
function limpiarGasto(g) {
  const imp = parseFloat(String(g.importe ?? '').replace(/,/g, ''));
  return {
    id: t(g.id, 40) || 'g' + Date.now().toString(36),
    fecha: fecha(g.fecha), concepto: t(g.concepto, 120), proveedor: t(g.proveedor, 120),
    importe: Number.isFinite(imp) ? imp : 0, moneda: g.moneda === 'USD' ? 'USD' : 'MXN', pagado: !!g.pagado,
  };
}
// Solo pasan los campos conocidos; sirve para altas completas y para cambios parciales.
function limpiar(b) {
  const o = {};
  if (!b || typeof b !== 'object') return o;
  for (const k of TEXTO) if (k in b) o[k] = t(b[k], k === 'nota' ? 2000 : 400);
  for (const k of NUM) if (k in b) { const x = b[k] === null || b[k] === '' ? null : Number(b[k]); o[k] = Number.isFinite(x) ? x : null; }
  for (const k of BOOL) if (k in b) o[k] = !!b[k];
  if (b.hitos && typeof b.hitos === 'object') {
    o.hitos = {};
    for (const k of HITOS) if (b.hitos[k] && typeof b.hitos[k] === 'object') o.hitos[k] = limpiarHito(b.hitos[k]);
  }
  if (Array.isArray(b.gastos)) o.gastos = b.gastos.slice(0, 200).map(limpiarGasto);
  if (b.reportePrevio && typeof b.reportePrevio === 'object') o.reportePrevio = limpiarPrevio(b.reportePrevio);
  return o;
}
// Mezcla un cambio parcial: los objetos se combinan, todo lo demás (incluidas listas) se reemplaza.
function mezclar(a, b) {
  const r = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) r[k] = v && typeof v === 'object' && !Array.isArray(v) ? mezclar(r[k], v) : v;
  return r;
}
const idValido = (id) => /^[A-Za-z0-9_.\-]{1,60}$/.test(id || '');

// ---------- Datos ----------
async function listar() {
  if (pool) return (await pool.query('SELECT id, datos, actualizada FROM op_manzanillo')).rows.map((r) => ({ id: r.id, ...r.datos, actualizada: r.actualizada }));
  return Object.entries(leer()).map(([id, d]) => ({ id, ...d }));
}
async function crear(id, datos) {
  if (pool) return (await pool.query('INSERT INTO op_manzanillo (id, datos) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, datos])).rowCount > 0;
  const o = leer(); if (o[id]) return false; o[id] = datos; escribir(o); return true;
}
async function cambiar(id, cambio) {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT datos FROM op_manzanillo WHERE id = $1 FOR UPDATE', [id]);
      if (!r.rowCount) { await c.query('ROLLBACK'); return null; }
      const d = mezclar(r.rows[0].datos, cambio);
      await c.query('UPDATE op_manzanillo SET datos = $2, actualizada = now() WHERE id = $1', [id, d]);
      await c.query('COMMIT');
      return d;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const o = leer(); if (!o[id]) return null;
  o[id] = mezclar(o[id], cambio); escribir(o); return o[id];
}
async function borrar(id) {
  if (pool) return (await pool.query('DELETE FROM op_manzanillo WHERE id = $1', [id])).rowCount > 0;
  const o = leer(); if (!o[id]) return false; delete o[id]; escribir(o); return true;
}

// ---------- Rutas ----------
function rutas(admin) {
  const r = express.Router();
  const err = (res, e, msg) => { console.error(e); res.status(500).json({ error: msg }); };

  r.get('/op-manzanillo', admin, (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'admin', 'op-manzanillo.html')));

  r.get('/api/admin/opm/embarques', admin, async (_req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await listar()); } catch (e) { err(res, e, 'No se pudieron leer los embarques'); }
  });
  r.post('/api/admin/opm/embarques', admin, async (req, res) => {
    const datos = limpiar(req.body);
    if (!datos.ref) return res.status(400).json({ error: 'Escribe la referencia.' });
    const id = datos.ref.toUpperCase().replace(/\//g, '-').replace(/[^A-Z0-9_.\-]/g, '');
    if (!idValido(id)) return res.status(400).json({ error: 'Referencia inválida.' });
    datos.creado = new Date().toISOString();
    try { (await crear(id, datos)) ? res.json({ ok: true, id }) : res.status(409).json({ error: `La referencia ${datos.ref} ya existe.` }); }
    catch (e) { err(res, e, 'No se pudo crear el embarque'); }
  });
  r.patch('/api/admin/opm/embarques/:id', admin, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: 'Datos inválidos' });
    const cambio = limpiar(req.body);
    // La referencia se puede corregir desde la ficha, siempre que no la tenga otro embarque
    if ('ref' in cambio) {
      cambio.ref = cambio.ref.toUpperCase();
      if (!cambio.ref) return res.status(400).json({ error: 'La referencia no puede quedar vacía.' });
      try {
        const otra = (await listar()).find((x) => x.id !== req.params.id && String(x.ref || '').toUpperCase() === cambio.ref);
        if (otra) return res.status(409).json({ error: `La referencia ${cambio.ref} ya la tiene otro embarque.` });
      } catch (e) { return err(res, e, 'No se pudo guardar'); }
    }
    try {
      const d = await cambiar(req.params.id, cambio);
      d ? res.json({ ok: true, datos: d }) : res.status(404).json({ error: 'No encontrado' });
    } catch (e) { err(res, e, 'No se pudo guardar'); }
  });
  // Reporte de previo: arma el PDF con lo que está en pantalla (ya editado)
  r.post('/api/admin/opm/embarques/:id/previo.pdf', admin, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: 'Datos inválidos' });
    try {
      const ref = String((req.body && req.body.trafico) || req.params.id.replace(/-(\d{2})$/, '/$1'));
      const buf = await generarPrevio(req.body || {}, ref);
      const nombre = `Reporte de previo ${ref}`.replace(/[\/\\:*?"<>|]+/g, '-') + '.pdf';
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store' }).send(buf);
    } catch (e) { err(res, e, 'No se pudo generar el PDF'); }
  });
  r.delete('/api/admin/opm/embarques/:id', admin, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: 'Datos inválidos' });
    try { (await borrar(req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'No encontrado' }); }
    catch (e) { err(res, e, 'No se pudo borrar'); }
  });
  return r;
}

module.exports = { init, rutas };

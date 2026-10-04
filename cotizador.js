// Cotizador: catálogo de tarifas (conceptos) y cotizaciones.
// Se guarda en Postgres (si hay DATABASE_URL) o en archivos JSON locales, igual que el resto de MEJAnet.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const Formula = require('./public/formula');
const { generarPDFCotizacion } = require('./cotizacion-pdf');

const pool = db.pool;
const FILE_CON = path.join(db.DIR, 'cot_conceptos.json');
const FILE_COT = path.join(db.DIR, 'cotizaciones.json');

const CATEGORIAS = ['FLETE / TRANSPORTE', 'ALMACENAJE', 'MANIOBRAS', 'ADUANAL', 'OTROS'];
const TIPOS = ['fijo', 'manual', 'formula'];
const ESTADOS = ['BORRADOR', 'ENVIADA', 'ACEPTADA', 'RECHAZADA'];

// Catálogo inicial de ejemplo. Precio 0 = "por definir" (se captura en la pantalla de Tarifas).
const SEMILLA = [
  { categoria: 'FLETE / TRANSPORTE', nombre: 'Flete local', unidad: 'VIAJE', moneda: 'USD', tipo: 'manual', precio: 0, iva: 0, formula: '' },
  { categoria: 'FLETE / TRANSPORTE', nombre: 'Flete por kilómetro', unidad: 'VIAJE', moneda: 'MXN', tipo: 'formula', precio: 0, iva: 16, formula: 'precio * km' },
  { categoria: 'ALMACENAJE', nombre: 'Almacenaje por tarima por día', unidad: 'SERVICIO', moneda: 'USD', tipo: 'formula', precio: 0, iva: 0, formula: 'precio * tarimas * dias' },
  { categoria: 'MANIOBRAS', nombre: 'Maniobra de descarga', unidad: 'SERVICIO', moneda: 'USD', tipo: 'fijo', precio: 0, iva: 0, formula: '' },
  { categoria: 'MANIOBRAS', nombre: 'Maniobra de carga', unidad: 'SERVICIO', moneda: 'USD', tipo: 'fijo', precio: 0, iva: 0, formula: '' },
  { categoria: 'ADUANAL', nombre: 'Honorarios agente aduanal', unidad: 'PEDIMENTO', moneda: 'MXN', tipo: 'manual', precio: 0, iva: 16, formula: '' },
  { categoria: 'ADUANAL', nombre: 'Prevalidación', unidad: 'PEDIMENTO', moneda: 'MXN', tipo: 'fijo', precio: 0, iva: 16, formula: '' },
  { categoria: 'OTROS', nombre: 'Seguro de mercancía (% del valor)', unidad: 'SERVICIO', moneda: 'USD', tipo: 'formula', precio: 0, iva: 0, formula: 'valor * precio / 100' },
];

const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const escribir = (f, x) => fs.writeFileSync(f, JSON.stringify(x));

async function init() {
  if (pool) {
    const { rows } = await pool.query("SELECT to_regclass('cot_conceptos') IS NOT NULL AS hay");
    await pool.query(`CREATE TABLE IF NOT EXISTS cot_conceptos (
      id SERIAL PRIMARY KEY,
      datos JSONB NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cotizaciones (
      id SERIAL PRIMARY KEY,
      folio INTEGER UNIQUE NOT NULL,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizada TIMESTAMPTZ NOT NULL DEFAULT now(),
      datos JSONB NOT NULL
    )`);
    if (!rows[0].hay) for (const c of SEMILLA) await pool.query('INSERT INTO cot_conceptos (datos) VALUES ($1)', [c]);
    return;
  }
  fs.mkdirSync(db.DIR, { recursive: true });
  if (!fs.existsSync(FILE_CON)) escribir(FILE_CON, SEMILLA.map((d, i) => ({ id: i + 1, datos: d })));
  if (!fs.existsSync(FILE_COT)) escribir(FILE_COT, []);
}

// ---------- Catálogo de conceptos ----------
async function listarConceptos() {
  if (pool) return (await pool.query('SELECT id, datos FROM cot_conceptos ORDER BY id')).rows;
  return leer(FILE_CON);
}
async function guardarConcepto(id, datos) {
  if (pool) {
    if (id) {
      const r = await pool.query('UPDATE cot_conceptos SET datos = $2 WHERE id = $1 RETURNING id', [id, datos]);
      return r.rowCount ? { id, datos } : null;
    }
    const r = await pool.query('INSERT INTO cot_conceptos (datos) VALUES ($1) RETURNING id', [datos]);
    return { id: r.rows[0].id, datos };
  }
  const lista = leer(FILE_CON);
  if (id) {
    const o = lista.find((x) => x.id === id);
    if (!o) return null;
    o.datos = datos; escribir(FILE_CON, lista); return o;
  }
  const reg = { id: lista.reduce((m, x) => Math.max(m, x.id), 0) + 1, datos };
  lista.push(reg); escribir(FILE_CON, lista); return reg;
}
async function borrarConcepto(id) {
  if (pool) return (await pool.query('DELETE FROM cot_conceptos WHERE id = $1', [id])).rowCount > 0;
  const lista = leer(FILE_CON), i = lista.findIndex((x) => x.id === id);
  if (i < 0) return false;
  lista.splice(i, 1); escribir(FILE_CON, lista); return true;
}

// ---------- Cotizaciones ----------
async function listarCotizaciones() {
  if (pool) return (await pool.query('SELECT id, folio, creada, actualizada, datos FROM cotizaciones ORDER BY folio DESC LIMIT 1000')).rows;
  return leer(FILE_COT).sort((a, b) => b.folio - a.folio);
}
async function obtenerCotizacion(id) {
  if (pool) return (await pool.query('SELECT id, folio, creada, actualizada, datos FROM cotizaciones WHERE id = $1', [id])).rows[0] || null;
  return leer(FILE_COT).find((x) => x.id === id) || null;
}
// El folio es consecutivo: siempre el siguiente al más alto.
async function crearCotizacion(datos) {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE cotizaciones IN EXCLUSIVE MODE');
      const r = await c.query('INSERT INTO cotizaciones (folio, datos) SELECT COALESCE(MAX(folio), 0) + 1, $1 FROM cotizaciones RETURNING id, folio, creada, actualizada', [datos]);
      await c.query('COMMIT');
      return { ...r.rows[0], datos };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const lista = leer(FILE_COT);
  const ahora = new Date().toISOString();
  const reg = { id: lista.reduce((m, x) => Math.max(m, x.id), 0) + 1, folio: lista.reduce((m, x) => Math.max(m, x.folio), 0) + 1, creada: ahora, actualizada: ahora, datos };
  lista.push(reg); escribir(FILE_COT, lista); return reg;
}
async function actualizarCotizacion(id, datos) {
  if (pool) {
    const r = await pool.query('UPDATE cotizaciones SET datos = $2, actualizada = now() WHERE id = $1 RETURNING id, folio, creada, actualizada', [id, datos]);
    return r.rowCount ? { ...r.rows[0], datos } : null;
  }
  const lista = leer(FILE_COT), o = lista.find((x) => x.id === id);
  if (!o) return null;
  o.datos = datos; o.actualizada = new Date().toISOString(); escribir(FILE_COT, lista); return o;
}
async function borrarCotizacion(id) {
  if (pool) return (await pool.query('DELETE FROM cotizaciones WHERE id = $1', [id])).rowCount > 0;
  const lista = leer(FILE_COT), i = lista.findIndex((x) => x.id === id);
  if (i < 0) return false;
  lista.splice(i, 1); escribir(FILE_COT, lista); return true;
}

// ---------- Limpieza de datos ----------
const t = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const n = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
const numTxt = (v) => { const s = t(v, 30).replace(/,/g, ''); return s === '' || !Number.isFinite(Number(s)) ? '' : s; };

function limpiarConcepto(b) {
  const d = {
    categoria: t(b.categoria, 60).toUpperCase() || 'OTROS',
    nombre: t(b.nombre, 160),
    unidad: t(b.unidad, 40).toUpperCase(),
    moneda: b.moneda === 'USD' ? 'USD' : 'MXN',
    tipo: TIPOS.includes(b.tipo) ? b.tipo : 'fijo',
    precio: n(b.precio),
    iva: n(b.iva),
    formula: t(b.formula, 400),
    nota: t(b.nota, 300),
    activo: b.activo !== false,
  };
  if (!d.nombre) throw new Error('Escribe el nombre del concepto.');
  if (d.tipo === 'formula') {
    if (!d.formula) throw new Error('Escribe la fórmula.');
    validarFormula(d.formula);
  } else d.formula = '';
  return d;
}
function validarFormula(f) {
  const arbol = Formula.compilar(f);
  const validas = new Set(Formula.VARIABLES.map((v) => v[0]));
  for (const v of Formula.variablesDe(arbol)) if (!validas.has(v)) throw new Error(`La fórmula usa "${v}", que no es una variable conocida.`);
}

function limpiarCotizacion(b) {
  const e = b.embarque || {};
  const partidas = (Array.isArray(b.partidas) ? b.partidas : []).slice(0, 80).map((p) => {
    const tipo = TIPOS.includes(p.tipo) ? p.tipo : 'fijo';
    const formula = tipo === 'formula' ? t(p.formula, 400) : '';
    if (formula) validarFormula(formula);
    return {
      concepto_id: Number.isInteger(p.concepto_id) ? p.concepto_id : null,
      categoria: t(p.categoria, 60).toUpperCase(),
      descripcion: t(p.descripcion, 300),
      unidad: t(p.unidad, 40).toUpperCase(),
      tipo, formula,
      cantidad: n(p.cantidad), precio: n(p.precio),
      moneda: p.moneda === 'USD' ? 'USD' : 'MXN',
      iva: n(p.iva),
    };
  }).filter((p) => p.descripcion || p.precio || p.cantidad);
  const datos = {
    estado: ESTADOS.includes(b.estado) ? b.estado : 'BORRADOR',
    cliente: t(b.cliente, 160).toUpperCase(),
    atencion: t(b.atencion, 120),
    correo: t(b.correo, 160),
    telefono: t(b.telefono, 60),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '') ? b.fecha : new Date().toISOString().slice(0, 10),
    vigencia: Math.max(0, Math.min(365, Math.round(n(b.vigencia)) || 15)),
    tc: numTxt(b.tc),
    elaboro: t(b.elaboro, 80),
    embarque: {
      servicio: t(e.servicio, 80).toUpperCase(), origen: t(e.origen, 120).toUpperCase(), destino: t(e.destino, 120).toUpperCase(),
      unidad: t(e.unidad, 80).toUpperCase(), mercancia: t(e.mercancia, 200),
      peso_kg: numTxt(e.peso_kg), tarimas: numTxt(e.tarimas), bultos: numTxt(e.bultos),
      dias: numTxt(e.dias), km: numTxt(e.km), valor: numTxt(e.valor), valor_moneda: e.valor_moneda === 'MXN' ? 'MXN' : 'USD',
    },
    partidas,
    notas: t(b.notas, 3000),
  };
  const hay = datos.cliente || partidas.length;
  if (!hay) throw new Error('La cotización está vacía.');
  return datos;
}

const folioTxt = (f) => `COT-${String(f).padStart(4, '0')}`;

// ---------- Rutas ----------
function rutas(admin) {
  const r = express.Router();
  const pagina = (archivo) => (_req, res) => res.sendFile(path.join(__dirname, 'admin', archivo));
  const err = (res, e, msg) => { console.error(e); res.status(500).json({ error: msg }); };
  const idDe = (req) => { const id = Number(req.params.id); return Number.isInteger(id) ? id : null; };

  r.get('/cotizador', admin, pagina('cotizador.html'));
  r.get('/cotizador/nueva', admin, pagina('cotizacion.html'));
  r.get('/cotizador/editar/:id', admin, pagina('cotizacion.html'));
  r.get('/cotizador/tarifas', admin, pagina('cot-tarifas.html'));

  // Catálogo
  r.get('/api/admin/cot/conceptos', admin, async (_req, res) => {
    try { res.json({ conceptos: await listarConceptos(), categorias: CATEGORIAS, variables: Formula.VARIABLES }); }
    catch (e) { err(res, e, 'No se pudieron leer las tarifas'); }
  });
  r.post('/api/admin/cot/conceptos', admin, async (req, res) => {
    let datos;
    try { datos = limpiarConcepto(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try { res.json({ ok: true, ...(await guardarConcepto(null, datos)) }); } catch (e) { err(res, e, 'No se pudo guardar'); }
  });
  r.put('/api/admin/cot/conceptos/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).json({ error: 'Datos inválidos' });
    let datos;
    try { datos = limpiarConcepto(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const reg = await guardarConcepto(id, datos);
      if (!reg) return res.status(404).json({ error: 'No encontrado' });
      res.json({ ok: true, ...reg });
    } catch (e) { err(res, e, 'No se pudo guardar'); }
  });
  r.delete('/api/admin/cot/conceptos/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).json({ error: 'Datos inválidos' });
    try { (await borrarConcepto(id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'No encontrado' }); }
    catch (e) { err(res, e, 'No se pudo borrar'); }
  });

  // Cotizaciones
  const conTotales = (reg) => {
    const c = Formula.calcular(reg.datos);
    return { ...reg, folio_txt: folioTxt(reg.folio), totales: c.totales, granMXN: c.granMXN, granUSD: c.granUSD };
  };
  r.get('/api/admin/cot/cotizaciones', admin, async (_req, res) => {
    try { res.json((await listarCotizaciones()).map(conTotales)); } catch (e) { err(res, e, 'No se pudieron leer las cotizaciones'); }
  });
  r.get('/api/admin/cot/cotizaciones/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).json({ error: 'Datos inválidos' });
    try {
      const reg = await obtenerCotizacion(id);
      reg ? res.json(conTotales(reg)) : res.status(404).json({ error: 'No encontrada' });
    } catch (e) { err(res, e, 'No se pudo leer'); }
  });
  r.post('/api/admin/cot/cotizaciones', admin, async (req, res) => {
    let datos;
    try { datos = limpiarCotizacion(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try { const reg = await crearCotizacion(datos); res.json({ ok: true, id: reg.id, folio: folioTxt(reg.folio) }); }
    catch (e) { err(res, e, 'No se pudo guardar la cotización'); }
  });
  r.put('/api/admin/cot/cotizaciones/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).json({ error: 'Datos inválidos' });
    let datos;
    try { datos = limpiarCotizacion(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const reg = await actualizarCotizacion(id, datos);
      reg ? res.json({ ok: true, id: reg.id, folio: folioTxt(reg.folio) }) : res.status(404).json({ error: 'No encontrada' });
    } catch (e) { err(res, e, 'No se pudo guardar la cotización'); }
  });
  // Cambiar solo el estado desde el tablero
  r.put('/api/admin/cot/cotizaciones/:id/estado', admin, async (req, res) => {
    const id = idDe(req); if (!id || !ESTADOS.includes(req.body.estado)) return res.status(400).json({ error: 'Datos inválidos' });
    try {
      const reg = await obtenerCotizacion(id);
      if (!reg) return res.status(404).json({ error: 'No encontrada' });
      await actualizarCotizacion(id, { ...reg.datos, estado: req.body.estado });
      res.json({ ok: true });
    } catch (e) { err(res, e, 'No se pudo guardar'); }
  });
  r.delete('/api/admin/cot/cotizaciones/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).json({ error: 'Datos inválidos' });
    try { (await borrarCotizacion(id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'No encontrada' }); }
    catch (e) { err(res, e, 'No se pudo borrar'); }
  });
  r.get('/api/admin/cot/cotizaciones/:id/pdf', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).send('Datos inválidos');
    try {
      const reg = await obtenerCotizacion(id);
      if (!reg) return res.status(404).send('No encontrada');
      const pdf = await generarPDFCotizacion(reg, Formula.calcular(reg.datos), folioTxt(reg.folio));
      res.type('pdf').set('Content-Disposition', `inline; filename="COTIZACION_${folioTxt(reg.folio)}.pdf"`).send(pdf);
    } catch (e) { console.error(e); res.status(500).send('No se pudo generar el PDF'); }
  });
  return r;
}

module.exports = { init, rutas };

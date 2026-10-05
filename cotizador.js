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

const CATEGORIAS = ['DESGLOSE DE CARGOS'];
const TIPOS = ['fijo', 'manual', 'formula'];
const ESTADOS = ['BORRADOR', 'ENVIADA', 'ACEPTADA', 'RECHAZADA'];
const TIPOS_COT = ['TERRESTRE', 'MARITIMA', 'FFCC'];
const OPERACIONES = ['IMPORTACION', 'EXPORTACION'];
const MODALIDADES = ['DOOR TO DOOR', 'FCL', 'LTL'];

// Conceptos iniciales (tomados de las cotizaciones de ejemplo). El monto 0 se captura en cada cotización.
const SEMILLA = [
  { categoria: 'DESGLOSE DE CARGOS', nombre: 'EXW OCEAN FREIGHT SHENZEN - MZLO', descripcion: 'RECOLECCION EXW, FLETE MARITIMO, DEST. SURGCHARGE, HANDLING FEE, AMS FEE', moneda: 'USD', tipo: 'manual', precio: 0, formula: '', predeterminado: true },
  { categoria: 'DESGLOSE DE CARGOS', nombre: 'INSURANCE D2D', descripcion: 'APROXIMATE', moneda: 'USD', tipo: 'manual', precio: 0, formula: '', predeterminado: true },
  { categoria: 'DESGLOSE DE CARGOS', nombre: 'DRAYAGE FROM MZLO - GPE NUEVO LEON', descripcion: 'MZLO - MTY - MZO', moneda: 'USD', tipo: 'manual', precio: 0, formula: '', predeterminado: true },
  { categoria: 'DESGLOSE DE CARGOS', nombre: 'SEGURO', descripcion: '', moneda: 'MXN', tipo: 'manual', precio: 0, formula: '', predeterminado: true },
  { categoria: 'DESGLOSE DE CARGOS', nombre: 'PAQUETE ALL IN', descripcion: 'PREVIO, BUQUE A PISO, PISO A BLOQUE, PISO A SPF', moneda: 'MXN', tipo: 'manual', precio: 0, formula: '', predeterminado: true },
  { categoria: 'DESGLOSE DE CARGOS', nombre: 'ENTREGA VACIO', descripcion: 'CAMION A PATIO', moneda: 'MXN', tipo: 'manual', precio: 0, formula: '', predeterminado: true },
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
      serie TEXT NOT NULL,
      folio INTEGER NOT NULL,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizada TIMESTAMPTZ NOT NULL DEFAULT now(),
      datos JSONB NOT NULL,
      UNIQUE (serie, folio)
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
// Cada tipo lleva su propia serie y numeración: CT terrestre, CM marítima, CF ferrocarril.
const SERIES = { TERRESTRE: 'CT', MARITIMA: 'CM', FFCC: 'CF' };
const serieDe = (tipo) => SERIES[tipo];
const COLS = 'id, serie, folio, creada, actualizada, datos';

async function listarCotizaciones() {
  if (pool) return (await pool.query(`SELECT ${COLS} FROM cotizaciones ORDER BY creada DESC LIMIT 1000`)).rows;
  return leer(FILE_COT).sort((a, b) => String(b.creada).localeCompare(String(a.creada)));
}
async function obtenerCotizacion(id) {
  if (pool) return (await pool.query(`SELECT ${COLS} FROM cotizaciones WHERE id = $1`, [id])).rows[0] || null;
  return leer(FILE_COT).find((x) => x.id === id) || null;
}
// El folio se asigna al guardar: el siguiente al más alto de su serie, sin huecos.
async function crearCotizacion(datos) {
  const serie = serieDe(datos.tipo);
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE cotizaciones IN EXCLUSIVE MODE');
      const r = await c.query(`INSERT INTO cotizaciones (serie, folio, datos)
        SELECT $1, COALESCE(MAX(folio), 0) + 1, $2 FROM cotizaciones WHERE serie = $1 RETURNING ${COLS}`, [serie, datos]);
      await c.query('COMMIT');
      return r.rows[0];
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const lista = leer(FILE_COT);
  const ahora = new Date().toISOString();
  const folio = lista.filter((x) => x.serie === serie).reduce((m, x) => Math.max(m, x.folio), 0) + 1;
  const reg = { id: lista.reduce((m, x) => Math.max(m, x.id), 0) + 1, serie, folio, creada: ahora, actualizada: ahora, datos };
  lista.push(reg); escribir(FILE_COT, lista); return reg;
}
// Si al editar se cambia el tipo, la cotización toma el siguiente folio de la nueva serie.
async function actualizarCotizacion(id, datos) {
  const serie = serieDe(datos.tipo);
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await c.query('SELECT serie FROM cotizaciones WHERE id = $1 FOR UPDATE', [id]);
      if (!a.rowCount) { await c.query('ROLLBACK'); return null; }
      let r;
      if (a.rows[0].serie === serie) {
        r = await c.query(`UPDATE cotizaciones SET datos = $2, actualizada = now() WHERE id = $1 RETURNING ${COLS}`, [id, datos]);
      } else {
        await c.query('LOCK TABLE cotizaciones IN EXCLUSIVE MODE');
        r = await c.query(`UPDATE cotizaciones SET serie = $2, folio = (SELECT COALESCE(MAX(folio), 0) + 1 FROM cotizaciones WHERE serie = $2),
          datos = $3, actualizada = now() WHERE id = $1 RETURNING ${COLS}`, [id, serie, datos]);
      }
      await c.query('COMMIT');
      return r.rows[0];
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const lista = leer(FILE_COT), o = lista.find((x) => x.id === id);
  if (!o) return null;
  if (o.serie !== serie) { o.folio = lista.filter((x) => x.serie === serie).reduce((m, x) => Math.max(m, x.folio), 0) + 1; o.serie = serie; }
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
const numTxt = (v) => { const s = t(v, 30).replace(/[,$\s]/g, ''); return s === '' || !Number.isFinite(Number(s)) ? '' : s; };

function limpiarConcepto(b) {
  const d = {
    categoria: t(b.categoria, 60).toUpperCase() || 'DESGLOSE DE CARGOS',
    nombre: t(b.nombre, 160).toUpperCase(),
    descripcion: t(b.descripcion, 300).toUpperCase(),
    moneda: b.moneda === 'USD' ? 'USD' : 'MXN',
    tipo: TIPOS.includes(b.tipo) ? b.tipo : 'fijo',
    precio: n(b.precio),
    formula: t(b.formula, 400),
    nota: t(b.nota, 300),
    predeterminado: !!b.predeterminado,
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

const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const unoDe = (v, lista) => (lista.includes(v) ? v : '');
function limpiarCotizacion(b) {
  const im = b.impuestos || {};
  const cargos = (Array.isArray(b.cargos) ? b.cargos : []).slice(0, 80).map((p) => {
    const tipo = p.tipo === 'formula' ? 'formula' : 'manual';
    const formula = tipo === 'formula' ? t(p.formula, 400) : '';
    if (formula) validarFormula(formula);
    return {
      concepto_id: Number.isInteger(p.concepto_id) ? p.concepto_id : null,
      concepto: t(p.concepto, 160).toUpperCase(),
      descripcion: t(p.descripcion, 300).toUpperCase(),
      moneda: p.moneda === 'USD' ? 'USD' : 'MXN',
      tipo, formula,
      precio: numTxt(p.precio),
      monto: numTxt(p.monto),
    };
  }).filter((p) => p.concepto || p.descripcion || p.monto || p.formula);
  const datos = {
    version: 2,
    estado: ESTADOS.includes(b.estado) ? b.estado : 'BORRADOR',
    cliente: t(b.cliente, 160).toUpperCase(),
    tipo: unoDe(b.tipo, TIPOS_COT),
    trafico: t(b.trafico, 40).toUpperCase(),
    fecha: fecha(b.fecha) || new Date().toISOString().slice(0, 10),
    valido_hasta: fecha(b.valido_hasta),
    operacion: unoDe(b.operacion, OPERACIONES),
    naviera: t(b.naviera, 80).toUpperCase(),
    modalidad: unoDe(b.modalidad, MODALIDADES),
    contenedor: t(b.contenedor, 20).toUpperCase(),
    proveedor: t(b.proveedor, 160).toUpperCase(),
    buque_eta: t(b.buque_eta, 120).toUpperCase(),
    tc: numTxt(b.tc),
    cargos,
    impuestos: {
      factura: t(im.factura, 120).toUpperCase(),
      valor_usd: numTxt(im.valor_usd), tc: numTxt(im.tc), incrementables: numTxt(im.incrementables), valor_aduana: numTxt(im.valor_aduana),
      mercancia: t(im.mercancia, 200).toUpperCase(), regimen: t(im.regimen, 120).toUpperCase(),
      igi: numTxt(im.igi), dta: numTxt(im.dta), iva: numTxt(im.iva), prevalidacion: numTxt(im.prevalidacion), contraprestacion: numTxt(im.contraprestacion),
    },
    notas: t(b.notas, 3000),
    elaboro: t(b.elaboro, 80),
  };
  if (!datos.tipo) throw new Error('Elige el tipo de cotización (Terrestre, Marítima o FFCC).');
  if (!datos.cliente && !cargos.length) throw new Error('La cotización está vacía.');
  return datos;
}

const folioTxt = (reg) => `${reg.serie}-${String(reg.folio).padStart(4, '0')}`;

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
    return { ...reg, folio_txt: folioTxt(reg), totalMXN: c.totalMXN, totalUSD: c.totalUSD, granMXN: c.granMXN, granUSD: c.granUSD };
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
    try { const reg = await crearCotizacion(datos); res.json({ ok: true, id: reg.id, folio: folioTxt(reg) }); }
    catch (e) { err(res, e, 'No se pudo guardar la cotización'); }
  });
  r.put('/api/admin/cot/cotizaciones/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(400).json({ error: 'Datos inválidos' });
    let datos;
    try { datos = limpiarCotizacion(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const reg = await actualizarCotizacion(id, datos);
      reg ? res.json({ ok: true, id: reg.id, folio: folioTxt(reg) }) : res.status(404).json({ error: 'No encontrada' });
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
      const pdf = await generarPDFCotizacion(reg, Formula.calcular(reg.datos), folioTxt(reg));
      res.type('pdf').set('Content-Disposition', `inline; filename="COTIZACION_${folioTxt(reg)}.pdf"`).send(pdf);
    } catch (e) { console.error(e); res.status(500).send('No se pudo generar el PDF'); }
  });
  return r;
}

module.exports = { init, rutas };

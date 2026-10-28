// Reportes Shipper Normal guardados: uno por referencia.
// Se guardan solos al generarse y se actualizan con cada cambio (partidas borradas, traducciones, referencia).
// Si se vuelve a convertir una referencia que ya existe, se actualiza ese mismo reporte.
// Se guarda en Postgres (si hay DATABASE_URL) o en un archivo JSON local, igual que el resto de MEJAnet.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');

const pool = db.pool;
const FILE = path.join(db.DIR, 'shipper_reportes.json');

const leer = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const escribir = (x) => { fs.mkdirSync(db.DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(x)); };
const txt = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clave = (s) => txt(s).toUpperCase();

// Igual que en la página: junta descripciones que solo cambian en singular/plural
function singular(w) {
  if (w.length < 4) return w;
  if (/CES$/.test(w)) return w.slice(0, -3) + 'Z';
  if (/[AEIOU]S$/.test(w)) w = w.slice(0, -1);
  // MOTOR / MOTORES y BUJE / BUJES quedan igual quitando la E final tras R, L, N, D o J
  if (/[RLNDJ]E$/.test(w)) w = w.slice(0, -1);
  return w;
}
const claveGrupo = (s) => clave(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Z0-9Ñ]+/).filter(Boolean).map(singular).join(' ');

class RefOcupada extends Error {}

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS shipper_reportes (
      id SERIAL PRIMARY KEY,
      referencia TEXT NOT NULL,
      ref_clave TEXT NOT NULL UNIQUE,
      archivo TEXT,
      datos JSONB NOT NULL,
      resumen JSONB NOT NULL,
      creado TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      creado_por TEXT,
      actualizado_por TEXT
    )`);
  } else if (!fs.existsSync(FILE)) {
    escribir([]);
  }
}

// Revisa y recorta lo que manda la página
function limpiar(body) {
  const referencia = txt(body?.referencia, 60);
  if (!referencia) throw new Error('Falta la referencia del reporte.');
  const partidas = (Array.isArray(body?.partidas) ? body.partidas : []).slice(0, 3000).map((p) => ({
    sec: typeof p?.sec === 'number' ? p.sec : txt(p?.sec, 40),
    frac: txt(p?.frac, 20),
    prov: txt(p?.prov, 200),
    desc: txt(p?.desc, 500),
    qty: num(p?.qty),
    umc: txt(p?.umc, 20),
    val: num(p?.val),
    peso: num(p?.peso),
  })).filter((p) => p.frac);
  if (!partidas.length) throw new Error('El reporte no tiene partidas.');
  const borradas = [...new Set((Array.isArray(body?.borradas) ? body.borradas : []).map((b) => txt(b, 600)))].slice(0, 3000);
  const ingles = {};
  for (const [k, v] of Object.entries(body?.ingles && typeof body.ingles === 'object' ? body.ingles : {}).slice(0, 3000)) ingles[clave(k).slice(0, 500)] = txt(v, 500).toUpperCase();

  // Resumen para la lista (sin las partidas borradas)
  const vivas = partidas.filter((p) => !borradas.includes(p.frac + '|' + claveGrupo(p.desc)) && !borradas.includes(p.frac + '|' + clave(p.desc)));
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const resumen = {
    partidas: vivas.length,
    borradas: partidas.length - vivas.length,
    fracciones: new Set(vivas.map((p) => p.frac)).size,
    valor: r6(vivas.reduce((s, p) => s + p.val, 0)),
    peso: r6(vivas.reduce((s, p) => s + p.peso, 0)),
    proveedores: [...new Set(vivas.map((p) => p.prov).filter(Boolean))].slice(0, 20),
  };
  return { referencia, ref_clave: clave(referencia), archivo: txt(body?.archivo, 200), datos: { partidas, borradas, ingles }, resumen };
}

const COLS_LISTA = 'id, referencia, archivo, resumen, creado, actualizado, creado_por, actualizado_por';

async function listar() {
  if (pool) return (await pool.query(`SELECT ${COLS_LISTA} FROM shipper_reportes ORDER BY actualizado DESC LIMIT 2000`)).rows;
  return leer().map(({ datos, ref_clave, ...r }) => r).sort((a, b) => String(b.actualizado).localeCompare(String(a.actualizado)));
}

async function obtener(id) {
  if (pool) return (await pool.query(`SELECT ${COLS_LISTA}, datos FROM shipper_reportes WHERE id = $1`, [id])).rows[0] || null;
  return leer().find((x) => x.id === id) || null;
}

// Nuevo reporte (o la misma referencia otra vez): se crea, o se actualiza el que ya existe con esa referencia
async function guardarPorReferencia(r, usuario) {
  if (pool) {
    const q = await pool.query(
      `INSERT INTO shipper_reportes (referencia, ref_clave, archivo, datos, resumen, creado_por, actualizado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (ref_clave) DO UPDATE SET referencia = EXCLUDED.referencia, archivo = EXCLUDED.archivo, datos = EXCLUDED.datos,
         resumen = EXCLUDED.resumen, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por
       RETURNING id, (xmax = 0) AS nuevo`,
      [r.referencia, r.ref_clave, r.archivo, r.datos, r.resumen, usuario || null]
    );
    return q.rows[0];
  }
  const lista = leer();
  const ahora = new Date().toISOString();
  const ya = lista.find((x) => x.ref_clave === r.ref_clave);
  if (ya) { Object.assign(ya, r, { actualizado: ahora, actualizado_por: usuario || null }); escribir(lista); return { id: ya.id, nuevo: false }; }
  const id = lista.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  lista.push({ id, ...r, creado: ahora, actualizado: ahora, creado_por: usuario || null, actualizado_por: usuario || null });
  escribir(lista);
  return { id, nuevo: true };
}

// Cambios a un reporte abierto (partidas borradas, traducciones, referencia)
async function actualizar(id, r, usuario) {
  if (pool) {
    try {
      const q = await pool.query(
        `UPDATE shipper_reportes SET referencia = $2, ref_clave = $3, archivo = COALESCE(NULLIF($4, ''), archivo), datos = $5, resumen = $6,
           actualizado = now(), actualizado_por = $7 WHERE id = $1 RETURNING id`,
        [id, r.referencia, r.ref_clave, r.archivo, r.datos, r.resumen, usuario || null]
      );
      return q.rowCount > 0;
    } catch (e) {
      if (e.code === '23505') throw new RefOcupada();
      throw e;
    }
  }
  const lista = leer();
  const o = lista.find((x) => x.id === id);
  if (!o) return false;
  if (lista.some((x) => x.id !== id && x.ref_clave === r.ref_clave)) throw new RefOcupada();
  Object.assign(o, r, { archivo: r.archivo || o.archivo, actualizado: new Date().toISOString(), actualizado_por: usuario || null });
  escribir(lista);
  return true;
}

async function borrar(id) {
  if (pool) return (await pool.query('DELETE FROM shipper_reportes WHERE id = $1', [id])).rowCount > 0;
  const lista = leer(), i = lista.findIndex((x) => x.id === id);
  if (i < 0) return false;
  lista.splice(i, 1); escribir(lista); return true;
}

function rutas(admin) {
  const r = express.Router();
  const json = express.json({ limit: '5mb' }); // un reporte grande puede traer cientos de partidas
  const idDe = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
  const fallo = (res, e) => { console.error(e); res.status(500).json({ error: 'No se pudo completar. Intenta de nuevo.' }); };

  r.get('/api/shipper', admin, async (_req, res) => {
    try { res.json({ reportes: await listar() }); } catch (e) { fallo(res, e); }
  });
  r.get('/api/shipper/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(404).json({ error: 'Ese reporte no existe.' });
    try { const x = await obtener(id); x ? res.json(x) : res.status(404).json({ error: 'Ese reporte ya no existe; quizá alguien lo borró.' }); } catch (e) { fallo(res, e); }
  });
  r.post('/api/shipper', admin, json, async (req, res) => {
    let d; try { d = limpiar(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try { res.json(await guardarPorReferencia(d, req.usuario)); } catch (e) { fallo(res, e); }
  });
  r.put('/api/shipper/:id', admin, json, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(404).json({ error: 'Ese reporte no existe.' });
    let d; try { d = limpiar(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      (await actualizar(id, d, req.usuario)) ? res.json({ id }) : res.status(404).json({ error: 'Ese reporte ya no existe; quizá alguien lo borró.' });
    } catch (e) {
      if (e instanceof RefOcupada) return res.status(409).json({ error: `Ya hay otro reporte guardado con la referencia ${d.referencia}.` });
      fallo(res, e);
    }
  });
  r.delete('/api/shipper/:id', admin, async (req, res) => {
    const id = idDe(req); if (!id) return res.status(404).json({ error: 'Ese reporte no existe.' });
    try { (await borrar(id)) ? res.json({ ok: true }) : res.status(404).json({ error: 'Ese reporte ya no existe.' }); } catch (e) { fallo(res, e); }
  });
  return r;
}

module.exports = { init, rutas };

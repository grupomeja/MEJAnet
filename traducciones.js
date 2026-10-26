// Traducciones español → inglés de descripciones de mercancía (Reporte Shipper).
// Glosario propio: primero se busca aquí; lo que no está se traduce automáticamente y se guarda.
// Cuando alguien corrige una traducción en la página, se guarda como "manual" y ya no se vuelve a traducir.
// Se guarda en Postgres (si hay DATABASE_URL) o en un archivo JSON local, igual que el resto de MEJAnet.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');

const pool = db.pool;
const FILE = path.join(db.DIR, 'traducciones.json');

const clave = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
const leer = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const escribir = (o) => { fs.mkdirSync(db.DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o)); };

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS traducciones (
      es TEXT PRIMARY KEY,
      en TEXT NOT NULL,
      fuente TEXT NOT NULL DEFAULT 'auto',
      usuario TEXT,
      actualizada TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  }
}

async function buscar(claves) {
  if (pool) {
    const r = await pool.query('SELECT es, en, fuente FROM traducciones WHERE es = ANY($1)', [claves]);
    return new Map(r.rows.map((x) => [x.es, x]));
  }
  const g = leer();
  return new Map(claves.filter((k) => g[k]).map((k) => [k, { es: k, ...g[k] }]));
}

async function guardar(es, en, fuente, usuario) {
  if (pool) {
    // Una traducción automática nunca reemplaza una corrección manual
    await pool.query(
      `INSERT INTO traducciones (es, en, fuente, usuario) VALUES ($1, $2, $3, $4)
       ON CONFLICT (es) DO UPDATE SET en = EXCLUDED.en, fuente = EXCLUDED.fuente, usuario = EXCLUDED.usuario, actualizada = now()
       WHERE traducciones.fuente <> 'manual' OR EXCLUDED.fuente = 'manual'`,
      [es, en, fuente, usuario || null]
    );
    return;
  }
  const g = leer();
  if (g[es]?.fuente === 'manual' && fuente !== 'manual') return;
  g[es] = { en, fuente, usuario: usuario || null, actualizada: new Date().toISOString() };
  escribir(g);
}

// Traducción automática (servicio público de Google Translate, sin llave)
async function traducirAuto(texto) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=' + encodeURIComponent(texto);
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('traductor respondió ' + r.status);
  const j = await r.json();
  const en = (j?.[0] || []).map((s) => s?.[0] || '').join('').trim();
  if (!en) throw new Error('traducción vacía');
  return en.toUpperCase();
}

function rutas(admin) {
  const r = express.Router();

  // { textos: ["EMPAQUES DE CAUCHO", ...] } → { traducciones: [{ es, en, fuente }] }
  r.post('/api/traducir', admin, async (req, res) => {
    const textos = Array.isArray(req.body?.textos) ? req.body.textos : [];
    const claves = [...new Set(textos.map(clave).filter(Boolean))].slice(0, 300);
    try {
      const hay = await buscar(claves);
      const faltan = claves.filter((k) => !hay.has(k));
      // Se traducen de 5 en 5 para no saturar el servicio
      for (let i = 0; i < faltan.length; i += 5) {
        await Promise.all(faltan.slice(i, i + 5).map(async (k) => {
          try {
            const en = await traducirAuto(k);
            hay.set(k, { es: k, en, fuente: 'auto' });
            await guardar(k, en, 'auto');
          } catch (e) {
            console.error('Traducción automática falló:', k, e.message);
          }
        }));
      }
      res.json({ traducciones: claves.map((k) => hay.get(k) || { es: k, en: '', fuente: 'sin' }) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'No se pudieron obtener las traducciones.' });
    }
  });

  // Corrección manual: { es, en }
  r.put('/api/traducir', admin, async (req, res) => {
    const es = clave(req.body?.es);
    const en = String(req.body?.en || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!es || !en) return res.status(400).json({ error: 'Falta la descripción o su traducción.' });
    if (en.length > 500) return res.status(400).json({ error: 'La traducción es demasiado larga.' });
    try {
      await guardar(es, en, 'manual', req.usuario);
      res.json({ es, en, fuente: 'manual' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'No se pudo guardar la traducción.' });
    }
  });

  return r;
}

module.exports = { init, rutas };

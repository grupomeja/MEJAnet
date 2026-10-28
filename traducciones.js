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

// --- Traducción automática ---
// Google (servicio público, sin llave) limita cuántas solicitudes acepta seguidas y responde 429.
// Por eso: todas las descripciones van juntas en una sola solicitud (una por renglón), se reintenta
// si pide esperar, y lo que aún falte se intenta con MyMemory como respaldo.
const espera = (ms) => new Promise((z) => setTimeout(z, ms));

async function google(texto) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=' + encodeURIComponent(texto);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error('Google respondió ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return (j?.[0] || []).map((x) => x?.[0] || '').join('');
}

// Varias descripciones en una sola solicitud; devuelve una traducción por descripción (o null)
async function googleLote(textos) {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const lineas = (await google(textos.join('\n'))).split('\n').map((x) => x.trim());
      if (lineas.length === textos.length) return lineas.map((x) => x || null);
      // Si no regresaron renglón por renglón, se traducen uno por uno
      const out = [];
      for (const t of textos) { out.push((await google(t)).trim() || null); await espera(250); }
      return out;
    } catch (e) {
      const reintentable = e.status === 429 || e.status >= 500 || e.name === 'TimeoutError';
      if (!reintentable || intento === 2) { console.error('Traducción automática (Google) falló:', e.message, '·', textos.length, 'descripciones'); break; }
      await espera(intento === 0 ? 2000 : 6000);
    }
  }
  return textos.map(() => null);
}

async function myMemory(texto) {
  const url = 'https://api.mymemory.translated.net/get?langpair=es|en&q=' + encodeURIComponent(texto);
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('MyMemory respondió ' + r.status);
  const j = await r.json();
  if (Number(j?.responseStatus) !== 200) throw new Error('MyMemory: ' + (j?.responseDetails || j?.responseStatus));
  return String(j?.responseData?.translatedText || '').trim();
}

async function traducirVarios(textos) {
  const res = new Map();
  // Lotes de hasta ~1500 caracteres por solicitud
  const lotes = []; let lote = [], largo = 0;
  for (const t of textos) {
    if (lote.length && largo + t.length + 1 > 1500) { lotes.push(lote); lote = []; largo = 0; }
    lote.push(t); largo += t.length + 1;
  }
  if (lote.length) lotes.push(lote);
  for (const l of lotes) {
    const out = await googleLote(l);
    l.forEach((t, i) => { if (out[i]) res.set(t, out[i].toUpperCase()); });
  }
  // Respaldo: lo que Google no tradujo
  const faltan = textos.filter((t) => !res.has(t)).slice(0, 80);
  for (const t of faltan) {
    try { const en = await myMemory(t); if (en) res.set(t, en.toUpperCase()); }
    catch (e) { console.error('Traducción automática (MyMemory) falló:', t, e.message); }
    await espera(200);
  }
  return res;
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
      if (faltan.length) {
        const nuevas = await traducirVarios(faltan);
        for (const [k, en] of nuevas) {
          hay.set(k, { es: k, en, fuente: 'auto' });
          await guardar(k, en, 'auto');
        }
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

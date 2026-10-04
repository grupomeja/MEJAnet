// Guarda las órdenes en Postgres (si hay DATABASE_URL) o en archivos JSON locales.
// Cada vez que alguien abre la página se le reserva un número de OC nuevo (secuencia).
const fs = require('fs');
const path = require('path');

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
}

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'ordenes.json');
const CONT = path.join(DIR, 'contador.json');

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ordenes (
      id SERIAL PRIMARY KEY,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      datos JSONB NOT NULL
    )`);
    await pool.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS oc INTEGER');
    await pool.query('UPDATE ordenes SET oc = id WHERE oc IS NULL');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS ordenes_oc_idx ON ordenes (oc)');
    await pool.query('CREATE SEQUENCE IF NOT EXISTS oc_seq');
    // Que el contador nunca quede por debajo de la OC más alta ya guardada
    const m = await pool.query('SELECT COALESCE(MAX(oc), 0) AS m FROM ordenes');
    const s = await pool.query('SELECT last_value, is_called FROM oc_seq');
    const actual = s.rows[0].is_called ? Number(s.rows[0].last_value) : 0;
    if (Number(m.rows[0].m) > actual) await pool.query('SELECT setval(\'oc_seq\', $1, true)', [Number(m.rows[0].m)]);
  } else {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');
    if (!fs.existsSync(CONT)) {
      const max = JSON.parse(fs.readFileSync(FILE, 'utf8')).reduce((a, o) => Math.max(a, o.oc || o.id || 0), 0);
      fs.writeFileSync(CONT, String(max));
    }
  }
}

// Reserva y devuelve el siguiente número de OC (1, 2, 3, ...)
async function reservarOC() {
  if (pool) return Number((await pool.query("SELECT nextval('oc_seq') AS n")).rows[0].n);
  const n = Number(fs.readFileSync(CONT, 'utf8')) + 1;
  fs.writeFileSync(CONT, String(n));
  return n;
}

async function ultimoOCEmitido() {
  if (pool) {
    const s = await pool.query('SELECT last_value, is_called FROM oc_seq');
    return s.rows[0].is_called ? Number(s.rows[0].last_value) : 0;
  }
  return Number(fs.readFileSync(CONT, 'utf8'));
}

async function existeOC(oc) {
  if (pool) return (await pool.query('SELECT 1 FROM ordenes WHERE oc = $1', [oc])).rowCount > 0;
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).some((o) => o.oc === oc);
}

async function guardar(datos, oc) {
  if (pool) {
    const r = await pool.query('INSERT INTO ordenes (oc, datos) VALUES ($1, $2) RETURNING id, oc, creada', [oc, datos]);
    return { id: r.rows[0].id, oc: r.rows[0].oc, creada: r.rows[0].creada, datos };
  }
  const lista = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const id = (lista.at(-1)?.id || 0) + 1;
  const reg = { id, oc, creada: new Date().toISOString(), datos };
  lista.push(reg);
  fs.writeFileSync(FILE, JSON.stringify(lista));
  return reg;
}

async function listar() {
  if (pool) {
    const r = await pool.query('SELECT id, oc, creada, datos FROM ordenes ORDER BY oc DESC LIMIT 500');
    return r.rows;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).reverse().slice(0, 500);
}

async function obtener(id) {
  if (pool) {
    const r = await pool.query('SELECT id, oc, creada, datos FROM ordenes WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).find((o) => o.id === id) || null;
}

module.exports = { init, reservarOC, ultimoOCEmitido, existeOC, guardar, listar, obtener };

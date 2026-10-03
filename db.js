// Guarda las órdenes en Postgres (si hay DATABASE_URL) o en un archivo JSON local.
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

const FILE = path.join(__dirname, 'data', 'ordenes.json');

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ordenes (
      id SERIAL PRIMARY KEY,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      datos JSONB NOT NULL
    )`);
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');
  }
}

async function guardar(datos) {
  if (pool) {
    const r = await pool.query('INSERT INTO ordenes (datos) VALUES ($1) RETURNING id, creada', [datos]);
    return { id: r.rows[0].id, creada: r.rows[0].creada, datos };
  }
  const lista = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const id = (lista.at(-1)?.id || 0) + 1;
  const reg = { id, creada: new Date().toISOString(), datos };
  lista.push(reg);
  fs.writeFileSync(FILE, JSON.stringify(lista));
  return reg;
}

async function listar() {
  if (pool) {
    const r = await pool.query('SELECT id, creada, datos FROM ordenes ORDER BY id DESC LIMIT 500');
    return r.rows;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).reverse().slice(0, 500);
}

async function obtener(id) {
  if (pool) {
    const r = await pool.query('SELECT id, creada, datos FROM ordenes WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).find((o) => o.id === id) || null;
}

module.exports = { init, guardar, listar, obtener };

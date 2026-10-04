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

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ordenes (
      id SERIAL PRIMARY KEY,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      datos JSONB NOT NULL
    )`);
    await pool.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS oc INTEGER');
    await pool.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS correo BOOLEAN NOT NULL DEFAULT false');
    await pool.query("ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS manual JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query('UPDATE ordenes SET oc = id WHERE oc IS NULL');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS ordenes_oc_idx ON ordenes (oc)');
  } else {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');
  }
}

// El número de OC se asigna al guardar: siempre es el siguiente al más alto, sin huecos.
async function guardar(datos) {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE ordenes IN EXCLUSIVE MODE'); // una orden a la vez
      const r = await c.query(
        'INSERT INTO ordenes (oc, datos) SELECT COALESCE(MAX(oc), 0) + 1, $1 FROM ordenes RETURNING id, oc, creada',
        [datos]
      );
      await c.query('COMMIT');
      return { id: r.rows[0].id, oc: r.rows[0].oc, creada: r.rows[0].creada, datos };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  const lista = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const id = (lista.at(-1)?.id || 0) + 1;
  const oc = lista.reduce((m, o) => Math.max(m, o.oc || o.id || 0), 0) + 1;
  const reg = { id, oc, creada: new Date().toISOString(), datos };
  lista.push(reg);
  fs.writeFileSync(FILE, JSON.stringify(lista));
  return reg;
}

async function marcarCorreo(id, ok) {
  if (pool) { await pool.query('UPDATE ordenes SET correo = $2 WHERE id = $1', [id, ok]); return; }
  const lista = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const o = lista.find((x) => x.id === id);
  if (o) { o.correo = ok; fs.writeFileSync(FILE, JSON.stringify(lista)); }
}

// Cambio manual de estado. valor: true / false, o null para quitar el cambio manual (vuelve a lo que diga el escaneo).
function aplicaManual(manual, n, campo, valor) {
  const m = { ...(manual || {}) };
  const fila = { ...(m[n] || {}) };
  if (valor === null) delete fila[campo]; else fila[campo] = valor;
  if (Object.keys(fila).length) m[n] = fila; else delete m[n];
  return m;
}

async function cambiarManual(id, n, campo, valor) {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT manual FROM ordenes WHERE id = $1 FOR UPDATE', [id]);
      if (!r.rowCount) { await c.query('ROLLBACK'); return null; }
      const m = aplicaManual(r.rows[0].manual, n, campo, valor);
      await c.query('UPDATE ordenes SET manual = $2 WHERE id = $1', [id, m]);
      await c.query('COMMIT');
      return m;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const lista = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const o = lista.find((x) => x.id === id);
  if (!o) return null;
  o.manual = aplicaManual(o.manual, n, campo, valor);
  fs.writeFileSync(FILE, JSON.stringify(lista));
  return o.manual;
}

async function listar() {
  if (pool) {
    const r = await pool.query('SELECT id, oc, creada, correo, manual, datos FROM ordenes ORDER BY oc DESC LIMIT 500');
    return r.rows;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).reverse().slice(0, 500);
}

async function obtener(id) {
  if (pool) {
    const r = await pool.query('SELECT id, oc, creada, manual, datos FROM ordenes WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).find((o) => o.id === id) || null;
}

module.exports = { init, guardar, marcarCorreo, cambiarManual, listar, obtener };

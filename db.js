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
const FILE_EB = path.join(DIR, 'entradas_bodega.json');
const SEED_EB = path.join(__dirname, 'seed', 'entradas_bodega.json'); // carga inicial desde el Excel "-STATUS- 2026 -"

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
    // Entradas de bodega (antes en el Excel "-STATUS- 2026 -")
    await pool.query(`CREATE TABLE IF NOT EXISTS entradas_bodega (
      id SERIAL PRIMARY KEY,
      referencia TEXT UNIQUE NOT NULL,
      anio INTEGER NOT NULL,
      num INTEGER NOT NULL,
      creada TIMESTAMPTZ NOT NULL DEFAULT now(),
      datos JSONB NOT NULL
    )`);
  } else {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');
    if (!fs.existsSync(FILE_EB)) fs.writeFileSync(FILE_EB, '[]');
  }
  await cargarSemillaEB();
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

// --- Entradas de bodega ---
// Referencia: "MEJA 0001/26" -> num 1, anio 26
function partesRef(ref) {
  const m = /(\d+)\s*\/\s*(\d{2})\s*$/.exec(ref || '');
  return m ? { num: Number(m[1]), anio: Number(m[2]) } : { num: 0, anio: 0 };
}

// Si la tabla está vacía y existe el archivo de carga inicial, lo importa una sola vez.
async function cargarSemillaEB() {
  if (!fs.existsSync(SEED_EB)) return;
  const filas = JSON.parse(fs.readFileSync(SEED_EB, 'utf8'));
  if (pool) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM entradas_bodega');
    if (rows[0].n) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const f of filas) {
        const { referencia, ...datos } = f, p = partesRef(referencia);
        await c.query('INSERT INTO entradas_bodega (referencia, anio, num, datos) VALUES ($1,$2,$3,$4) ON CONFLICT (referencia) DO NOTHING',
          [referencia, p.anio, p.num, datos]);
      }
      await c.query('COMMIT');
      console.log(`Entradas de bodega importadas: ${filas.length}`);
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    return;
  }
  if (JSON.parse(fs.readFileSync(FILE_EB, 'utf8')).length) return;
  const lista = filas.map((f, i) => {
    const { referencia, ...datos } = f, p = partesRef(referencia);
    return { id: i + 1, referencia, ...p, creada: new Date().toISOString(), datos };
  });
  fs.writeFileSync(FILE_EB, JSON.stringify(lista));
}

class RefRepetida extends Error {}

// Guarda un registro nuevo con la referencia que escribió el usuario (MEJA ####/##).
async function guardarEntradaEB(referencia, datos) {
  const p = partesRef(referencia);
  if (pool) {
    try {
      const r = await pool.query('INSERT INTO entradas_bodega (referencia, anio, num, datos) VALUES ($1,$2,$3,$4) RETURNING id, creada',
        [referencia, p.anio, p.num, datos]);
      return { id: r.rows[0].id, referencia, creada: r.rows[0].creada, datos };
    } catch (e) { if (e.code === '23505') throw new RefRepetida(); throw e; }
  }
  const lista = JSON.parse(fs.readFileSync(FILE_EB, 'utf8'));
  if (lista.some((o) => o.referencia === referencia)) throw new RefRepetida();
  const reg = { id: lista.reduce((m, o) => Math.max(m, o.id), 0) + 1, referencia, ...p, creada: new Date().toISOString(), datos };
  lista.push(reg);
  fs.writeFileSync(FILE_EB, JSON.stringify(lista));
  return reg;
}

// Cambia uno o varios campos de un registro. `referencia` puede venir entre los cambios.
async function actualizarEntradaEB(id, cambios) {
  const { referencia, ...resto } = cambios;
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT referencia, datos FROM entradas_bodega WHERE id = $1 FOR UPDATE', [id]);
      if (!r.rowCount) { await c.query('ROLLBACK'); return null; }
      const datos = { ...r.rows[0].datos, ...resto };
      const ref = referencia || r.rows[0].referencia, p = partesRef(ref);
      await c.query('UPDATE entradas_bodega SET referencia = $2, anio = $3, num = $4, datos = $5 WHERE id = $1', [id, ref, p.anio, p.num, datos]);
      await c.query('COMMIT');
      return { id, referencia: ref, datos };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') throw new RefRepetida();
      throw e;
    } finally { c.release(); }
  }
  const lista = JSON.parse(fs.readFileSync(FILE_EB, 'utf8'));
  const o = lista.find((x) => x.id === id);
  if (!o) return null;
  if (referencia && referencia !== o.referencia) {
    if (lista.some((x) => x.referencia === referencia)) throw new RefRepetida();
    Object.assign(o, { referencia }, partesRef(referencia));
  }
  o.datos = { ...o.datos, ...resto };
  fs.writeFileSync(FILE_EB, JSON.stringify(lista));
  return { id, referencia: o.referencia, datos: o.datos };
}

async function listarEntradasEB() {
  if (pool) {
    const r = await pool.query('SELECT id, referencia, creada, datos FROM entradas_bodega ORDER BY anio DESC, num DESC');
    return r.rows;
  }
  return JSON.parse(fs.readFileSync(FILE_EB, 'utf8')).sort((a, b) => b.anio - a.anio || b.num - a.num)
    .map(({ id, referencia, creada, datos }) => ({ id, referencia, creada, datos }));
}

module.exports = { init, guardar, marcarCorreo, cambiarManual, listar, obtener, guardarEntradaEB, actualizarEntradaEB, listarEntradasEB, RefRepetida };

// OP Manzanillo: seguimiento de operaciones marítimas por el puerto de Manzanillo.
// Un registro por embarque (referencia) con sus datos, hitos (estimada / confirmada / real) y gastos.
// Se guarda en Postgres (si hay DATABASE_URL) o en un archivo JSON local, igual que el resto de MEJAnet.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const { limpiarPrevio, generarPrevio } = require('./previo-pdf');
const drive = require('./drive-gastos');

const pool = db.pool;
const FILE = path.join(db.DIR, 'op_manzanillo.json');
const SEED = path.join(__dirname, 'seed', 'op_manzanillo.json'); // carga inicial desde el Excel "REPORTE DE DESPACHOS"

const HITOS = ['zarpe', 'arribo', 'revalidacion', 'previo', 'despacho', 'retiro'];
const TEXTO = ['ref', 'operacion', 'cliente', 'semaforoFecha', 'bultos', 'tipoCont', 'buque', 'viaje', 'bandera', 'hbl', 'mbl', 'ff', 'tipo', 'previo', 'mercancia', 'marca', 'factura',
  'contenedores', 'terminal', 'claveCR', 'pedimento', 'semaforo', 'estado', 'nota', 'origen', 'origen_puerto', 'creado'];
const NUM = ['peso', 'diasLibres'];
const BOOL = ['pedimentoPagado', 'gastosCerrada'];

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
  await importar('2026-10-31', path.join(__dirname, 'seed', 'actualizacion_2026-10-31.json'));
  await importar('2026-11-07', path.join(__dirname, 'seed', 'actualizacion_2026-11-07.json'));
  if (pool) await pool.query(`CREATE TABLE IF NOT EXISTS opm_archivos (
      id TEXT PRIMARY KEY, embarque TEXT NOT NULL, nombre TEXT NOT NULL, tipo TEXT NOT NULL,
      datos BYTEA NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await importarGastos('gastos-2026-11-06', path.join(__dirname, 'seed', 'gastos_2026-11-06.json'));
  if (pool) await pool.query('CREATE TABLE IF NOT EXISTS opm_drive (archivo TEXT PRIMARY KEY, drive_id TEXT NOT NULL)');
  // Referencias que MEJAnet escribió en el Google Sheet de control (solo esas se quitan al borrar el embarque)
  if (pool) await pool.query('CREATE TABLE IF NOT EXISTS opm_refsheet (id TEXT PRIMARY KEY, ref TEXT NOT NULL)');
  // Primera vez que se conecta Google Drive: copia lo que ya existe (archivos y resúmenes)
  if (drive.activo() && !(await yaAplicada('drive-inicial'))) {
    await marcarAplicada('drive-inicial');
    (async () => { for (const e of await listar()) if ((e.gastos || []).length) await drive.sincronizar(null, e, ARCH); console.log('OP Manzanillo: copia inicial a Google Drive enviada'); })().catch((e) => console.error('Drive inicial:', e.message));
  }
}

// ---------- Archivos (para la copia en Google Drive) ----------
const ARCH = {
  async leerArchivo(id) {
    if (pool) return (await pool.query('SELECT nombre, tipo, datos FROM opm_archivos WHERE id = $1', [id])).rows[0] || null;
    const dir = path.join(db.DIR, 'opm_archivos'); if (!fs.existsSync(path.join(dir, id))) return null;
    return { ...JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')), datos: fs.readFileSync(path.join(dir, id)) };
  },
  async guardarDriveId(id, did) {
    if (pool) await pool.query('INSERT INTO opm_drive (archivo, drive_id) VALUES ($1,$2) ON CONFLICT (archivo) DO UPDATE SET drive_id = $2', [id, did]);
  },
  async leerDriveId(id) {
    if (pool) { const q = await pool.query('SELECT drive_id FROM opm_drive WHERE archivo = $1', [id]); return q.rows[0] && q.rows[0].drive_id; }
    return null;
  },
};
async function obtener(id) {
  if (pool) { const q = await pool.query('SELECT datos FROM op_manzanillo WHERE id = $1', [id]); return q.rows[0] ? q.rows[0].datos : null; }
  return leer()[id] || null;
}

// ---------- Gastos capturados de las tablas de pagos (se agregan una sola vez, sin duplicar) ----------
async function importarGastos(nombre, archivo) {
  if (!fs.existsSync(archivo) || await yaAplicada(nombre)) return;
  const lista = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const actuales = Object.fromEntries((await listar()).map((x) => [x.id, x]));
  let n = 0;
  for (const [id, filas] of Object.entries(lista)) {
    const e = actuales[id]; if (!e) { console.log(`OP Manzanillo [${nombre}]: ${id} no existe, se omite`); continue; }
    const ya = e.gastos || [];
    const nuevos = filas.filter((f) => !ya.some((g) => (g.factura || '') === f.factura && Math.abs((+g.importe || 0) - f.importe) < 0.01))
      .map((f, i) => limpiarGasto({ ...f, id: 'g' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 6), moneda: 'MXN' }));
    if (!nuevos.length) continue;
    await cambiar(id, { gastos: ya.concat(nuevos) }); n += nuevos.length;
    console.log(`OP Manzanillo [${nombre}]: ${e.ref} → ${nuevos.length} gastos`);
  }
  await marcarAplicada(nombre);
  console.log(`OP Manzanillo [${nombre}]: ${n} gastos agregados`);
}

// ---------- Actualizaciones desde el Excel "REPORTE DE DESPACHOS" ----------
// Se aplican una sola vez (quedan registradas). Reglas:
//  · referencia nueva → se crea el embarque;
//  · datos generales (cliente, buque, BL, forwarder, terminal…) → solo se llenan si están vacíos;
//  · estatus, ETA y fechas de previo/despacho del reporte → se actualizan;
//  · "CUMPLIDO" → despacho real y semáforo (si no tiene). Sigue en Activas (verde) hasta que se capture el retiro.
const GENERALES = ['cliente', 'buque', 'viaje', 'hbl', 'mbl', 'ff', 'tipo', 'mercancia', 'terminal', 'previo', 'operacion', 'pedimento'];
async function yaAplicada(nombre) {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS opm_importaciones (nombre TEXT PRIMARY KEY, aplicada TIMESTAMPTZ NOT NULL DEFAULT now())');
    return (await pool.query('SELECT 1 FROM opm_importaciones WHERE nombre = $1', [nombre])).rowCount > 0;
  }
  return fs.existsSync(path.join(db.DIR, `opm_import_${nombre}.ok`));
}
async function marcarAplicada(nombre) {
  if (pool) await pool.query('INSERT INTO opm_importaciones (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [nombre]);
  else { fs.mkdirSync(db.DIR, { recursive: true }); fs.writeFileSync(path.join(db.DIR, `opm_import_${nombre}.ok`), new Date().toISOString()); }
}
async function importar(nombre, archivo) {
  if (!fs.existsSync(archivo) || await yaAplicada(nombre)) return;
  const lista = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const actuales = Object.fromEntries((await listar()).map((x) => [x.id, x]));
  let nuevos = 0, cambiados = 0;
  for (const u of Object.values(lista)) {
    const id = u.ref.replace(/\//g, '-');
    const hitos = JSON.parse(JSON.stringify(u.hitos || {}));
    if (u.eta) hitos.arribo = { ...(hitos.arribo || {}), e: u.eta };
    const e = actuales[id];
    if (!e) {
      const doc = { ref: u.ref, operacion: u.operacion || '', bandera: '', marca: '', factura: '', peso: null, bultos: '', contenedores: '',
        claveCR: '', pedimento: '', semaforo: u.semaforo || '', diasLibres: null, gastos: [], ...Object.fromEntries(GENERALES.filter((k) => u[k]).map((k) => [k, u[k]])),
        nota: u.nota || '', hitos, estado: 'activa', origen: `Excel REPORTE DE DESPACHOS ${nombre}`, creado: new Date().toISOString() };
      if (await crear(id, doc)) { nuevos++; console.log(`OP Manzanillo [${nombre}]: nuevo ${u.ref}`); }
      continue;
    }
    const cambio = {}, que = [];
    for (const k of GENERALES) if (u[k] && !String(e[k] ?? '').trim()) { cambio[k] = u[k]; que.push(k); }
    if (u.nota && u.nota !== e.nota) { cambio.nota = u.nota; que.push('estatus'); }
    const h = {};
    for (const [k, v] of Object.entries(hitos)) {
      const act = (e.hitos && e.hitos[k]) || {}, n = {};
      if (v.e && v.e !== act.e) n.e = v.e;
      if (v.hora && v.hora !== act.hora) n.hora = v.hora;
      if (v.r && !act.r) n.r = v.r;
      if (Object.keys(n).length) { h[k] = n; que.push(k); }
    }
    if (Object.keys(h).length) cambio.hitos = h;
    if (u.semaforo && !e.semaforo) { cambio.semaforo = u.semaforo; que.push('semáforo'); }
    if (que.length) { await cambiar(id, cambio); cambiados++; console.log(`OP Manzanillo [${nombre}]: ${u.ref} → ${que.join(', ')}`); }
  }
  await marcarAplicada(nombre);
  console.log(`OP Manzanillo [${nombre}]: ${nuevos} embarques nuevos y ${cambiados} actualizados desde el Excel`);
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
// Referencia a un archivo guardado (PDF o XML de la factura)
function archivoRef(a) {
  if (!a || typeof a !== 'object' || !/^[a-z0-9]{8,40}$/i.test(String(a.id || ''))) return null;
  return { id: String(a.id), nombre: t(a.nombre, 160) };
}
function limpiarGasto(g) {
  const imp = parseFloat(String(g.importe ?? '').replace(/,/g, ''));
  return {
    id: t(g.id, 40) || 'g' + Date.now().toString(36),
    fecha: fecha(g.fecha), concepto: t(g.concepto, 120), proveedor: t(g.proveedor, 160),
    importe: Number.isFinite(imp) ? imp : 0, moneda: g.moneda === 'USD' ? 'USD' : 'MXN', pagado: !!g.pagado,
    factura: t(g.factura, 60), detalle: t(g.detalle, 400), metodo: g.metodo === 'PUE' || g.metodo === 'PPD' ? g.metodo : '',
    uuid: t(g.uuid, 60), pdf: archivoRef(g.pdf), xml: archivoRef(g.xml), pago: archivoRef(g.pago), cpdf: archivoRef(g.cpdf), cxml: archivoRef(g.cxml),
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
    try {
      if (!(await crear(id, datos))) return res.status(409).json({ error: `La referencia ${datos.ref} ya existe.` });
      res.json({ ok: true, id });
      // Deja registro de la referencia y su cliente en el Google Sheet de control (MANZANILLO 26)
      drive.registrarRef(datos.ref, datos.cliente || '').then(async (r) => { if (r && !r.existente && pool) await pool.query('INSERT INTO opm_refsheet (id, ref) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET ref = EXCLUDED.ref', [id, datos.ref]); return r; }).then((r) => r && console.log(`OP Manzanillo: ${datos.ref} ${r.existente ? 'ya estaba' : 'registrada'} en el control de referencias (fila ${r.fila})`))
        .catch((e) => console.error('Control de referencias (' + datos.ref + '):', e.message));
    } catch (e) { err(res, e, 'No se pudo crear el embarque'); }
  });
  // Siguiente referencia consecutiva según la columna MEJA del Google Sheet de control
  r.get('/api/admin/opm/siguiente-ref', admin, async (req, res) => {
    try {
      const ocupadas = (await listar()).map((x) => x.ref).filter(Boolean);
      res.json({ ok: true, ref: await drive.siguienteRef(ocupadas) });
    } catch (e) { res.status(502).json({ error: e.message || 'No se pudo consultar el control de referencias' }); }
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
      const tocaGastos = drive.activo() && ('gastos' in cambio || 'gastosCerrada' in cambio || 'ref' in cambio || 'cliente' in cambio);
      const antes = tocaGastos ? await obtener(req.params.id) : null;
      // Mantiene el Google Sheet de control (MANZANILLO 26) al día cuando cambian el cliente o la referencia
      const refAnt = antes && antes.ref, cliAnt = antes && antes.cliente;
      const d = await cambiar(req.params.id, cambio);
      d ? res.json({ ok: true, datos: d }) : res.status(404).json({ error: 'No encontrado' });
      if (d && tocaGastos) drive.sincronizar(antes, d, ARCH).catch((e) => console.error('Drive:', e.message));
      if (d && antes && ((d.cliente || '') !== (cliAnt || '') || (d.ref || '') !== (refAnt || ''))) {
        (async () => {
          const reg = pool ? (await pool.query('SELECT ref FROM opm_refsheet WHERE id = $1', [req.params.id])).rows[0] : null;
          // La referencia solo se renombra en el Sheet si la registró MEJAnet; el cliente se actualiza en cualquier renglón que coincida
          const renombra = reg && d.ref !== refAnt;
          const cliCambio = (d.cliente || '') !== (cliAnt || '');
          if (!renombra && !cliCambio) return;
          const r = await drive.actualizarRef(renombra ? d.ref : refAnt, cliCambio ? (d.cliente || '') : null, refAnt);
          if (!r) return;
          if (renombra && pool) await pool.query('UPDATE opm_refsheet SET ref = $2 WHERE id = $1', [req.params.id, d.ref]);
          if (!r.noEstaba) console.log(`OP Manzanillo: control de referencias actualizado (${refAnt}${renombra ? ' → ' + d.ref : ''}, cliente ${d.cliente || '-'})`);
        })().catch((e) => console.error('Control de referencias (actualizar):', e.message));
      }
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
  // PDF / XML de las facturas de gastos (se guardan en la base de datos)
  const TIPOS_ARCH = { pdf: 'application/pdf', xml: 'application/xml', pago: 'application/pdf', cpdf: 'application/pdf', cxml: 'application/xml' };
  r.post('/api/admin/opm/archivos', admin, express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
    try {
      const emb = String(req.query.emb || ''), tipo = String(req.query.tipo || '');
      if (!idValido(emb) || !TIPOS_ARCH[tipo] || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Archivo inválido' });
      const nombre = t(decodeURIComponent(String(req.get('x-nombre') || tipo)), 160) || tipo;
      const id = Date.now().toString(36) + require('crypto').randomBytes(6).toString('hex');
      if (pool) await pool.query('INSERT INTO opm_archivos (id, embarque, nombre, tipo, datos) VALUES ($1,$2,$3,$4,$5)', [id, emb, nombre, TIPOS_ARCH[tipo], req.body]);
      else { const dir = path.join(db.DIR, 'opm_archivos'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id), req.body); fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ nombre, tipo: TIPOS_ARCH[tipo] })); }
      res.json({ id, nombre });
    } catch (e) { err(res, e, 'No se pudo guardar el archivo'); }
  });
  r.get('/api/admin/opm/archivos/:id', admin, async (req, res) => {
    try {
      const id = String(req.params.id); if (!/^[a-z0-9]{8,40}$/i.test(id)) return res.status(400).end();
      let f = null;
      if (pool) { const q = await pool.query('SELECT nombre, tipo, datos FROM opm_archivos WHERE id = $1', [id]); f = q.rows[0]; }
      else { const dir = path.join(db.DIR, 'opm_archivos'); if (fs.existsSync(path.join(dir, id))) f = { ...JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')), datos: fs.readFileSync(path.join(dir, id)) }; }
      if (!f) return res.status(404).json({ error: 'No encontrado' });
      res.set({ 'Content-Type': f.tipo, 'Content-Disposition': `inline; filename="${String(f.nombre).replace(/[^\w.\- ]+/g, '_')}"`, 'Cache-Control': 'private, max-age=3600' }).send(f.datos);
    } catch (e) { err(res, e, 'No se pudo leer el archivo'); }
  });
  r.delete('/api/admin/opm/archivos/:id', admin, async (req, res) => {
    try {
      const id = String(req.params.id); if (!/^[a-z0-9]{8,40}$/i.test(id)) return res.status(400).end();
      if (pool) await pool.query('DELETE FROM opm_archivos WHERE id = $1', [id]);
      else { const dir = path.join(db.DIR, 'opm_archivos'); for (const f of [id, id + '.json']) if (fs.existsSync(path.join(dir, f))) fs.unlinkSync(path.join(dir, f)); }
      res.json({ ok: true });
    } catch (e) { err(res, e, 'No se pudo quitar el archivo'); }
  });
  r.delete('/api/admin/opm/embarques/:id', admin, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: 'Datos inválidos' });
    try {
      if (!(await borrar(req.params.id))) return res.status(404).json({ error: 'No encontrado' });
      res.json({ ok: true });
      if (pool) {
        const q = await pool.query('SELECT ref FROM opm_refsheet WHERE id = $1', [req.params.id]);
        if (q.rows[0]) {
          const ref = q.rows[0].ref;
          drive.borrarRef(ref).then(async (r) => {
            if (!r) return console.log(`Control de referencias: ${ref} no se quitó (falta la versión 3 del Apps Script)`);
            await pool.query('DELETE FROM opm_refsheet WHERE id = $1', [req.params.id]);
            console.log(`OP Manzanillo: ${ref} quitada del control de referencias`);
          }).catch((e) => console.error('Control de referencias (borrar ' + ref + '):', e.message));
        }
      }
    } catch (e) { err(res, e, 'No se pudo borrar'); }
  });
  return r;
}

module.exports = { init, rutas };

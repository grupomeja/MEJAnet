// Correo de MEJAnet: un solo remitente para todos los módulos.
// - La configuración (remitente y destinatarios de cada módulo) se edita en /herramientas/correo
//   y se guarda en la base de datos (Postgres o archivo JSON local, igual que el resto de MEJAnet).
// - La clave de envío NO se guarda aquí: sigue en Render → Environment (RESEND_API_KEY, o SMTP_USER/SMTP_PASS).
// - Con RESEND_API_KEY se envía por la API de Resend (HTTPS; funciona en el plan gratis de Render).
//   Si no, se usa SMTP, que solo funciona en planes de pago de Render.
//
// Uso desde cualquier módulo:
//   const { enviarCorreo } = require('./correo');
//   await enviarCorreo({ modulo: 'orden-de-carga', asunto, texto, adjuntos: [{ nombre, contenido: Buffer }] });
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');

const pool = db.pool;
const FILE = path.join(db.DIR, 'config_correo.json');

// Módulos que pueden mandar correo. "envia" indica si el módulo ya manda avisos hoy.
const MODULOS = [
  { id: 'orden-de-carga', nombre: 'Orden de Carga', envia: true, descripcion: 'Aviso con el PDF de cada orden nueva' },
  { id: 'entradas-bodega', nombre: 'Entradas Bodega', envia: false },
  { id: 'cotizador', nombre: 'Cotizador', envia: false },
  { id: 'op-manzanillo', nombre: 'OP Manzanillo', envia: false },
  { id: 'cajas-patio', nombre: 'Cajas en patio', envia: false },
];

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const limpiaNombre = (v) => String(v ?? '').replace(/[\r\n"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const limpiaEmail = (v) => String(v ?? '').trim().toLowerCase().slice(0, 200);

// Lista de correos a partir de texto con comas, punto y coma, espacios o saltos de línea
function listaCorreos(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const out = [];
  for (const x of arr) {
    const e = limpiaEmail(x);
    if (!e) continue;
    if (!EMAIL.test(e)) throw Object.assign(new Error(`"${e}" no es un correo válido.`), { status: 400 });
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > 30) throw Object.assign(new Error('Máximo 30 destinatarios por módulo.'), { status: 400 });
  return out;
}

// Valores iniciales tomados de las variables de Render que ya existían (MAIL_FROM y MAIL_TO)
function porDefecto() {
  const m = String(process.env.MAIL_FROM || '').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  const nombre = m ? limpiaNombre(m[1]) : 'MEJAnet';
  const direccion = m ? limpiaEmail(m[2]) : limpiaEmail(process.env.MAIL_FROM || '');
  let paraOC = [];
  try { paraOC = listaCorreos(process.env.MAIL_TO || ''); } catch { paraOC = []; }
  const modulos = {};
  for (const mod of MODULOS) modulos[mod.id] = { activo: mod.id === 'orden-de-carga', para: mod.id === 'orden-de-carga' ? paraOC : [] };
  return { nombre: nombre || 'MEJAnet', direccion, responder: '', modulos };
}

// Combina lo guardado con los valores por defecto (por si se agregan módulos nuevos)
function completar(guardada) {
  const base = porDefecto();
  if (!guardada) return base;
  const c = { ...base, ...guardada, modulos: { ...base.modulos } };
  for (const mod of MODULOS) if (guardada.modulos?.[mod.id]) c.modulos[mod.id] = { ...base.modulos[mod.id], ...guardada.modulos[mod.id] };
  return c;
}

async function init() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS config_correo (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      datos JSONB NOT NULL,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_por TEXT
    )`);
  }
}

let cache = null; // la configuración se lee seguido; se guarda en memoria hasta el siguiente cambio
async function leer() {
  if (cache) return cache;
  let guardada = null, meta = {};
  if (pool) {
    const r = await pool.query('SELECT datos, actualizado, actualizado_por FROM config_correo WHERE id = 1');
    if (r.rows[0]) { guardada = r.rows[0].datos; meta = { actualizado: r.rows[0].actualizado, actualizadoPor: r.rows[0].actualizado_por }; }
  } else {
    try { const x = JSON.parse(fs.readFileSync(FILE, 'utf8')); guardada = x.datos; meta = { actualizado: x.actualizado, actualizadoPor: x.actualizadoPor }; } catch { /* sin archivo todavía */ }
  }
  cache = { config: completar(guardada), guardada: !!guardada, ...meta };
  return cache;
}

// Valida lo que manda la página
function validar(b) {
  const nombre = limpiaNombre(b?.nombre) || 'MEJAnet';
  const direccion = limpiaEmail(b?.direccion);
  if (!EMAIL.test(direccion)) throw Object.assign(new Error('Escribe una dirección de remitente válida (por ejemplo avisos@mail.grupomeja.com).'), { status: 400 });
  const responder = limpiaEmail(b?.responder);
  if (responder && !EMAIL.test(responder)) throw Object.assign(new Error('La dirección para respuestas no es válida.'), { status: 400 });
  const modulos = {};
  for (const mod of MODULOS) {
    const m = b?.modulos?.[mod.id] || {};
    let para;
    try { para = listaCorreos(m.para); }
    catch (e) { e.message = `${mod.nombre}: ${e.message}`; throw e; }
    modulos[mod.id] = { activo: !!m.activo, para };
    if (modulos[mod.id].activo && !para.length) throw Object.assign(new Error(`${mod.nombre}: está activo pero no tiene destinatarios.`), { status: 400 });
  }
  return { nombre, direccion, responder, modulos };
}

async function guardar(config, usuario) {
  if (pool) {
    await pool.query(
      `INSERT INTO config_correo (id, datos, actualizado, actualizado_por) VALUES (1, $1, now(), $2)
       ON CONFLICT (id) DO UPDATE SET datos = EXCLUDED.datos, actualizado = now(), actualizado_por = EXCLUDED.actualizado_por`,
      [config, usuario || null]);
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ datos: config, actualizado: new Date().toISOString(), actualizadoPor: usuario || null }));
  }
  cache = null;
}

// Cómo se va a enviar, según las variables de Render
function metodo() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}

async function porResend(c) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const cuerpo = {
      from: `${c.nombre} <${c.direccion}>`,
      to: c.para,
      subject: c.asunto,
      text: c.texto,
    };
    if (c.html) cuerpo.html = c.html;
    if (c.responder) cuerpo.reply_to = c.responder;
    if (c.adjuntos.length) cuerpo.attachments = c.adjuntos.map((a) => ({ filename: a.nombre, content: Buffer.from(a.contenido).toString('base64') }));
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return await r.json().catch(() => ({}));
  } finally {
    clearTimeout(t);
  }
}

async function porSMTP(c) {
  const nodemailer = require('nodemailer');
  const puerto = Number(process.env.SMTP_PORT || 465);
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: puerto,
    secure: puerto === 465,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  // Por SMTP el remitente tiene que ser la misma cuenta con la que se inicia sesión
  return transporte.sendMail({
    from: `"${c.nombre}" <${process.env.SMTP_USER}>`,
    replyTo: c.responder || undefined,
    to: c.para.join(', '),
    subject: c.asunto, text: c.texto, html: c.html || undefined,
    attachments: c.adjuntos.map((a) => ({ filename: a.nombre, content: a.contenido })),
  });
}

// Envía un correo de un módulo. Si no se pasa "para", usa los destinatarios configurados del módulo.
// Devuelve { enviado: true } o { enviado: false, motivo } si el módulo está apagado; lanza error si falla.
async function enviarCorreo({ modulo, para, asunto, texto, html, adjuntos = [], forzar = false }) {
  const { config } = await leer();
  const mod = config.modulos[modulo];
  if (!mod) throw new Error(`Módulo de correo desconocido: ${modulo}`);
  if (!mod.activo && !forzar) return { enviado: false, motivo: 'El envío de correo está apagado para este módulo.' };
  const destinatarios = para ? listaCorreos(para) : mod.para;
  if (!destinatarios.length) throw new Error(`No hay destinatarios configurados para ${modulo}.`);
  const como = metodo();
  if (!como) throw new Error('Correo no configurado: falta RESEND_API_KEY (o SMTP_USER/SMTP_PASS) en Render.');
  if (como === 'resend' && !config.direccion) throw new Error('Falta la dirección del remitente en Configuración de correo.');
  const c = { nombre: config.nombre, direccion: config.direccion, responder: config.responder, para: destinatarios, asunto, texto: texto || '', html, adjuntos };
  if (como === 'resend') await porResend(c);
  else await porSMTP(c);
  return { enviado: true };
}

function rutas(admin) {
  const r = express.Router();
  const json = express.json({ limit: '100kb' });
  // Solo el usuario principal puede ver y cambiar la configuración de correo
  const principal = (req, res, next) => req.principal ? next()
    : res.status(403).json({ error: 'Solo el usuario principal puede cambiar la configuración de correo.' });
  const error = (res, e, msg) => {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: msg });
  };

  r.get('/herramientas/correo', admin, (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'admin', 'correo.html')));

  r.get('/api/correo/config', admin, principal, async (_req, res) => {
    try {
      const x = await leer();
      res.set('Cache-Control', 'no-store').json({
        config: x.config, guardada: x.guardada, actualizado: x.actualizado || null, actualizadoPor: x.actualizadoPor || null,
        modulos: MODULOS, metodo: metodo(),
        smtpUsuario: metodo() === 'smtp' ? process.env.SMTP_USER : null,
      });
    } catch (e) { error(res, e, 'No se pudo leer la configuración de correo.'); }
  });

  r.put('/api/correo/config', admin, principal, json, async (req, res) => {
    try {
      const c = validar(req.body);
      await guardar(c, req.usuario);
      console.log(`Configuración de correo actualizada por ${req.usuario}: remitente ${c.nombre} <${c.direccion}>`);
      res.json({ ok: true });
    } catch (e) { error(res, e, 'No se pudo guardar la configuración de correo.'); }
  });

  // Correo de prueba con la configuración ya guardada
  r.post('/api/correo/prueba', admin, principal, json, async (req, res) => {
    try {
      const para = listaCorreos(req.body?.para);
      if (!para.length) return res.status(400).json({ error: 'Escribe a qué correo mandar la prueba.' });
      const { config } = await leer();
      const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Matamoros' });
      await enviarCorreo({
        modulo: 'orden-de-carga', forzar: true, para,
        asunto: 'MEJAnet · Correo de prueba',
        texto: `Este es un correo de prueba de MEJAnet.\n\nRemitente: ${config.nombre} <${config.direccion}>\n` +
          `Enviado por: ${req.usuario}\nFecha: ${ahora}\n\nSi lo recibiste, la configuración de correo funciona.`,
      });
      console.log(`Correo de prueba enviado por ${req.usuario} a ${para.join(', ')}`);
      res.json({ ok: true });
    } catch (e) {
      console.error('Error en correo de prueba:', e.message);
      res.status(e.status || 502).json({ error: e.message });
    }
  });
  return r;
}

module.exports = { init, rutas, enviarCorreo, leer, metodo, MODULOS };

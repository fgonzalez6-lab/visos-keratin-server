const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1); // Railway está detrás de un proxy: así req.ip es la IP real

// ── Configuración (variables de entorno en Railway) ──────────────
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM     = process.env.TWILIO_WA_FROM;
const OWNER_WA    = process.env.OWNER_WA;
const ORIGENES    = (process.env.ALLOWED_ORIGINS || "https://visoskeratin.vercel.app")
  .split(",").map(s => s.trim()).filter(Boolean);
const MAX_WA_POR_NUMERO = Number(process.env.MAX_WA_POR_NUMERO) || 6;  // mensajes a un mismo número cada 24 h
const MAX_WA_DIA        = Number(process.env.MAX_WA_DIA) || 300;       // tope diario total (protege el saldo de Twilio)
// Versión 2 de la app: MOSTRAR_DURACION=false oculta la hora de fin a la clienta (la dueña la sigue viendo)
const MOSTRAR_DURACION  = String(process.env.MOSTRAR_DURACION || "true").toLowerCase() !== "false";

if (!ACCOUNT_SID || !AUTH_TOKEN || !OWNER_WA) {
  console.error("❌ Faltan variables de entorno de Twilio (o OWNER_WA). Configúralas en Railway.");
  process.exit(1);
}

// ── Firebase Admin: el servidor lee/escribe sin pasar por las reglas ──
let db;
try {
  const credencial = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "");
  admin.initializeApp({
    credential: admin.credential.cert(credencial),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://visos-keratin-default-rtdb.firebaseio.com",
  });
  db = admin.database();
} catch (e) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT falta o no es un JSON válido:", e.message);
  process.exit(1);
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

// ── CORS: solo la web del salón puede llamar desde un navegador ──
app.use(cors({
  origin: (origin, cb) => (!origin || ORIGENES.includes(origin)) ? cb(null, true) : cb(new Error("Origen no permitido")),
}));
app.use(express.json({ limit: "20kb" }));

// ── Límite de peticiones por IP (en memoria) ─────────────────────
const ventanas = new Map();
function permitir(clave, max, ventanaMs) {
  const ahora = Date.now();
  const arr = (ventanas.get(clave) || []).filter(t => ahora - t < ventanaMs);
  if (arr.length >= max) { ventanas.set(clave, arr); return false; }
  arr.push(ahora); ventanas.set(clave, arr);
  return true;
}
function limitarIP(nombre, max, ventanaMs) {
  return (req, res, next) => {
    if (!permitir(`${nombre}:${req.ip}`, max, ventanaMs)) {
      return res.status(429).json({ error: "Demasiadas solicitudes. Intenta más tarde." });
    }
    next();
  };
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, arr] of ventanas) if (!arr.some(t => ahora - t < 86400000)) ventanas.delete(k);
}, 600000).unref();

// ── Tope de WhatsApps: por número (24 h) y total diario ──────────
const enviosPorNumero = new Map();
let enviosDia = { dia: "", n: 0 };
function reservarEnvio(tel, esDuena) {
  const hoy = new Date().toISOString().slice(0, 10);
  if (enviosDia.dia !== hoy) enviosDia = { dia: hoy, n: 0 };
  if (enviosDia.n >= MAX_WA_DIA) return false;
  if (!esDuena) {
    const ahora = Date.now();
    const arr = (enviosPorNumero.get(tel) || []).filter(t => ahora - t < 86400000);
    if (arr.length >= MAX_WA_POR_NUMERO) { enviosPorNumero.set(tel, arr); return false; }
    arr.push(ahora); enviosPorNumero.set(tel, arr);
  }
  enviosDia.n++;
  return true;
}

// ── Texto seguro: lo que escribe una clienta nunca arma enlaces ni formato en nuestros mensajes ──
function limpiar(v, max) {
  return String(v == null ? "" : v)
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[enlace]")
    .replace(/\b[a-z0-9-]+\.(com|net|org|co|io|ly|me|xyz|app|link|info|biz)(\/\S*)?/gi, "[enlace]")
    .replace(/[\u0000-\u001f\u007f*_~`]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max || 120);
}
function citaSegura(c, key) {
  return {
    nombre: limpiar(c.nombre, 60),
    telefono: normalizarTelefono(String(c.telefono || c.tel || "").replace(/[^\d+]/g, "")),
    correo: limpiar(c.correo, 80),
    servicios: limpiar(c.servicios || c.servicio, 300),
    estilista: limpiar(c.estilista, 40),
    fecha: limpiar(c.fecha, 20),
    horaInicio: limpiar(c.horaInicio, 5),
    horaFin: limpiar(c.horaFin, 5),
    duracion: Number(c.duracion) || "",
    firebaseKey: key,
  };
}
function horaClienta(c) { return MOSTRAR_DURACION ? `${c.horaInicio} – ${c.horaFin} aprox.` : c.horaInicio; }
function telefonoValido(t) { return String(t || "").replace(/\D/g, "").length >= 10; }

// ── Normalizar número colombiano ─────────────────────────────────
function normalizarTelefono(tel) {
  if (!tel) return tel;
  // Quitar espacios, guiones, paréntesis
  let num = tel.replace(/[\s\-\(\)]/g, '');
  // Si ya tiene + dejarlo como está
  if (num.startsWith('+')) return num;
  // Si empieza con 57 agregar +
  if (num.startsWith('57') && num.length >= 11) return '+' + num;
  // Si es número local colombiano de 10 dígitos agregar +57
  if (num.length === 10) return '+57' + num;
  // Si tiene 12 dígitos y empieza con 57
  if (num.length === 12 && num.startsWith('57')) return '+' + num;
  return num;
}


// ── Mensaje para la clienta ──────────────────────────────────────
function msgClientaCita(c) {
  // cancelLink ahora apunta directamente a cancelar.html
  return (
    `✂️ *Visos Keratin* — ¡Cita confirmada!\n\n` +
    `Hola ${c.nombre} 💛\n\n` +
    `Tu cita ha sido agendada exitosamente:\n\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha}\n` +
    `🕐 *Hora:* ${horaClienta(c)}\n\n` +
    `📌 _Recuerda asistir sin niños ni acompañantes._\n\n` +
    `❌ *¿Necesitas cancelar tu cita?*\n` +
    `Recuerda que puedes cancelar con mínimo *5 horas de anticipación.*\n` +
    `Toca este enlace para cancelar directamente:\n` +
    `https://visoskeratin.vercel.app/cancelar.html?cancelar=${c.firebaseKey}\n\n` +
    `¡Te esperamos con todo listo! 💇‍♀️\n` +
    `_Visos Keratin: ¡Donde tu cabello encuentra su mejor versión!_`
  );
}

// ── Mensaje para la dueña ────────────────────────────────────────
function msgDuena(c) {
  return (
    `📅 *Nueva cita agendada — Visos Keratin*\n\n` +
    `👤 *Clienta:* ${c.nombre}\n` +
    `📞 *Teléfono:* ${c.telefono}\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha}\n` +
    `🕐 *Hora:* ${c.horaInicio} – ${c.horaFin}\n` +
    `✉️ *Correo:* ${c.correo || '—'}\n` +
    `⏱️ *Duración:* ${c.duracion || '—'} min\n\n` +
    `📋 Gestiona esta cita en: https://visoskeratin.vercel.app/admin.html`
  );
}

// ── Mensaje cancelación clienta ──────────────────────────────────
function msgCancelacionClienta(c) {
  return (
    `❌ *Visos Keratin* — Cita cancelada\n\n` +
    `Hola ${c.nombre}, tu cita ha sido cancelada:\n\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha} a las ${c.horaInicio}\n\n` +
    `Puedes reagendar cuando quieras desde este enlace:\n` +
    `https://visoskeratin.vercel.app\n\n` +
    `💜`
  );
}

// ── Mensaje cancelación dueña ─────────────────────────────────────
function msgCancelacionDuena(c) {
  return (
    `❌ *Cita cancelada — Visos Keratin*\n\n` +
    `👤 *Clienta:* ${c.nombre}\n` +
    `📞 *Teléfono:* ${c.telefono}\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha} a las ${c.horaInicio}`
  );
}


// ── Enviar WhatsApp helper ───────────────────────────────────────
async function enviarWA(to, body) {
  try {
    const msg = await client.messages.create({
      from: WA_FROM,
      to: `whatsapp:${to}`,
      body
    });
    console.log(`✅ WhatsApp → ${to} | SID: ${msg.sid}`);
    return { ok: true, sid: msg.sid };
  } catch (e) {
    console.error(`❌ WhatsApp → ${to} | Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}


// ── Mensajes de reprogramación (por reducción de estilistas) ─────
function msgReprogramacionClienta(c) {
  return (
    `🔄 *Visos Keratin* — Tu cita fue reprogramada\n\n` +
    `Hola ${c.nombre} 💛\n\n` +
    `Tuvimos que hacer un ajuste en la agenda y movimos tu cita:\n\n` +
    `📌 *Antes:* ${c.fechaAnterior} a las ${c.horaAnterior} con ${c.estilistaAnterior}\n\n` +
    `✅ *Ahora:*\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha}\n` +
    `🕐 *Hora:* ${horaClienta(c)}\n\n` +
    `Si esta nueva fecha no te funciona, puedes cancelarla con mínimo *5 horas de anticipación* y agendar de nuevo cuando quieras:\n` +
    `❌ Cancelar: https://visoskeratin.vercel.app/cancelar.html?cancelar=${c.firebaseKey}\n` +
    `📅 Agendar: https://visoskeratin.vercel.app\n\n` +
    `Gracias por tu comprensión 💜\n` +
    `_Visos Keratin: ¡Donde tu cabello encuentra su mejor versión!_`
  );
}

function msgReprogramacionDuena(c) {
  return (
    `🔄 *Cita reprogramada — Visos Keratin*\n\n` +
    `👤 *Clienta:* ${c.nombre}\n` +
    `📞 *Teléfono:* ${c.telefono || '—'}\n` +
    `🌿 *Servicios:* ${c.servicios}\n\n` +
    `📌 *Antes:* ${c.fechaAnterior} ${c.horaAnterior} · ${c.estilistaAnterior}\n` +
    `✅ *Ahora:* ${c.fecha} ${c.horaInicio} – ${c.horaFin} · ${c.estilista}\n\n` +
    `📋 Gestiona esta cita en: https://visoskeratin.vercel.app/admin.html`
  );
}


// ── Enviar a la clienta / a la dueña, respetando los topes ───────
async function enviarClienta(tel, body) {
  if (!telefonoValido(tel)) return { ok: false, note: "Sin teléfono válido" };
  if (!reservarEnvio(tel, false)) return { ok: false, note: "Límite de mensajes alcanzado" };
  return enviarWA(tel, body);
}
async function enviarDuena(body) {
  if (!reservarEnvio(OWNER_WA, true)) return { ok: false, note: "Límite diario alcanzado" };
  return enviarWA(OWNER_WA.replace("whatsapp:", ""), body);
}

// ── Datos de la cita: siempre desde Firebase, nunca desde la petición ──
function claveValida(k) { return typeof k === "string" && /^[-A-Za-z0-9_]{10,40}$/.test(k) ? k : null; }
async function leerCita(key) {
  const snap = await db.ref(`citas/${key}`).once("value");
  return snap.exists() ? snap.val() : null;
}
// Reserva "una sola vez" un aviso (transacción). Con firma distinta se puede volver a avisar.
async function reservarAviso(key, tipo, firma) {
  const r = await db.ref(`notificaciones/${key}/${tipo}`).transaction(actual => (actual === firma ? undefined : firma));
  return r.committed;
}
async function liberarAviso(key, tipo) {
  try { await db.ref(`notificaciones/${key}/${tipo}`).remove(); } catch (e) { /* ignorar */ }
}
const esperar = ms => new Promise(r => setTimeout(r, ms));

// ── Exigir sesión de administrador (ID token de Firebase Auth) ───
async function exigirAdmin(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return res.status(401).json({ error: "Falta iniciar sesión." });
  try {
    const dec = await admin.auth().verifyIdToken(m[1]);
    const snap = await db.ref(`admins/${dec.uid}`).once("value");
    if (snap.val() !== true) return res.status(403).json({ error: "No autorizado." });
    req.adminUid = dec.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: "Sesión inválida o vencida." });
  }
}

// ════════════════════════════════════════════════════════════════
// ENDPOINT: Horas ocupadas (sin datos personales)
// ════════════════════════════════════════════════════════════════
const LEGACY_EST = { "Ana": "e1", "Lucía": "e2", "Camila": "e3" };
const aMin = t => { const p = String(t || "0:0").split(":").map(Number); return p[0] * 60 + (p[1] || 0); };

app.get("/ocupados", limitarIP("ocupados", 300, 600000), async (req, res) => {
  const fecha = String(req.query.fecha || "");
  const est = String(req.query.estilista || "");
  if (!/^e[1-8]$/.test(est) || !/^\S{3} \d{1,2}\/\d{1,2}\/\d{4}$/.test(fecha)) {
    return res.status(400).json({ error: "Parámetros inválidos." });
  }
  try {
    const snap = await db.ref("citas").orderByChild("fecha").equalTo(fecha).once("value");
    const ocupados = [];
    snap.forEach(h => {
      const c = h.val();
      if (!c || c.estado === "cancelada") return;
      if ((c.estilistaId || LEGACY_EST[c.estilista]) !== est) return;
      ocupados.push({ s: aMin(c.horaInicio), e: aMin(c.horaFin) });
    });
    res.set("Cache-Control", "no-store");
    res.json({ ocupados });
  } catch (e) {
    console.error("❌ /ocupados:", e.message);
    res.status(500).json({ error: "No se pudo consultar la disponibilidad." });
  }
});

// ════════════════════════════════════════════════════════════════
// ENDPOINT: Nueva cita agendada
//   Recibe SOLO la clave de la cita; el contenido sale de Firebase.
// ════════════════════════════════════════════════════════════════
app.post("/agendar", limitarIP("agendar", 30, 3600000), async (req, res) => {
  const key = claveValida(req.body && req.body.firebaseKey);
  if (!key) return res.status(400).json({ error: "Falta la clave de la cita." });
  try {
    const c = await leerCita(key);
    if (!c) return res.status(404).json({ error: "Cita no encontrada." });
    if (c.estado !== "pendiente") return res.status(409).json({ error: "La cita no está pendiente." });
    if (!(await reservarAviso(key, "agendar", "1"))) return res.status(409).json({ error: "Esta cita ya fue notificada." });

    const cita = citaSegura(c, key);
    console.log(`\n🆕 Nueva cita: ${cita.nombre} | ${cita.servicios} | ${cita.fecha} ${cita.horaInicio}`);
    const [waClienta, waDuena] = await Promise.all([
      enviarClienta(cita.telefono, msgClientaCita(cita)),
      enviarDuena(msgDuena(cita)),
    ]);
    if (!waClienta.ok && !waDuena.ok) await liberarAviso(key, "agendar");
    res.json({ ok: true, waClienta: { ok: waClienta.ok }, waDuena: { ok: waDuena.ok } });
  } catch (e) {
    console.error("❌ /agendar:", e.message);
    res.status(500).json({ error: "No se pudo procesar." });
  }
});

// ════════════════════════════════════════════════════════════════
// ENDPOINT: Cancelación de cita
//   La cita ya debe figurar como cancelada en Firebase.
//   Acepta firebaseKey; si una versión antigua de la web no la envía,
//   se busca la cita cancelada que coincida (teléfono + fecha + hora).
// ════════════════════════════════════════════════════════════════
async function candidatasCancelacion(body) {
  const key = claveValida(body.firebaseKey);
  if (key) return [key];
  const fecha = String(body.fecha || "").slice(0, 20);
  const hora = String(body.horaInicio || "");
  const dig = String(body.telefono || "").replace(/\D/g, "").slice(-10);
  if (!fecha || !hora || dig.length < 10) return [];
  const snap = await db.ref("citas").orderByChild("fecha").equalTo(fecha).once("value");
  const out = [];
  snap.forEach(h => {
    const c = h.val();
    if (c && c.estado === "cancelada" && c.horaInicio === hora &&
        String(c.telefono || c.tel || "").replace(/\D/g, "").slice(-10) === dig) out.push(h.key);
  });
  return out;
}

app.post("/cancelar", limitarIP("cancelar", 30, 3600000), async (req, res) => {
  try {
    const candidatas = await candidatasCancelacion(req.body || {});
    if (!candidatas.length) return res.status(400).json({ error: "No se identificó la cita." });

    for (const key of candidatas) {
      let c = await leerCita(key);
      // el navegador guarda la cancelación y avisa casi a la vez: se espera un momento a que figure
      for (let i = 0; c && c.estado !== "cancelada" && i < 3; i++) { await esperar(700); c = await leerCita(key); }
      if (!c || c.estado !== "cancelada") continue;
      if (!(await reservarAviso(key, "cancelar", "1"))) continue;

      const cita = citaSegura(c, key);
      console.log(`\n❌ Cancelación: ${cita.nombre} | ${cita.servicios} | ${cita.fecha} ${cita.horaInicio}`);
      const [waClienta, waDuena] = await Promise.all([
        enviarClienta(cita.telefono, msgCancelacionClienta(cita)),
        enviarDuena(msgCancelacionDuena(cita)),
      ]);
      if (!waClienta.ok && !waDuena.ok) await liberarAviso(key, "cancelar");
      return res.json({ ok: true, waClienta: { ok: waClienta.ok }, waDuena: { ok: waDuena.ok } });
    }
    res.status(409).json({ error: "La cita no está cancelada o ya fue notificada." });
  } catch (e) {
    console.error("❌ /cancelar:", e.message);
    res.status(500).json({ error: "No se pudo procesar." });
  }
});

// ════════════════════════════════════════════════════════════════
// ENDPOINT: Cita reprogramada (solo administrador con sesión)
//   El admin ya guardó el cambio en Firebase; aquí solo se avisa.
// ════════════════════════════════════════════════════════════════
app.post("/reprogramar", limitarIP("reprogramar", 120, 3600000), exigirAdmin, async (req, res) => {
  const key = claveValida(req.body && req.body.firebaseKey);
  if (!key) return res.status(400).json({ error: "Falta la clave de la cita." });
  try {
    const c = await leerCita(key);
    if (!c || !c.reprogramadaDe) return res.status(404).json({ error: "La cita no tiene una reprogramación." });
    const firma = `${c.fecha}|${c.horaInicio}|${c.estilistaId || c.estilista}`;
    if (!(await reservarAviso(key, "reprogramar", firma))) return res.status(409).json({ error: "Este cambio ya fue notificado." });

    const cita = citaSegura(c, key);
    const antes = c.reprogramadaDe || {};
    cita.fechaAnterior = limpiar(antes.fecha, 20);
    cita.horaAnterior = limpiar(antes.horaInicio, 5);
    cita.estilistaAnterior = limpiar(antes.estilista, 40);
    console.log(`\n🔄 Reprogramación: ${cita.nombre} | ${cita.fechaAnterior} ${cita.horaAnterior} → ${cita.fecha} ${cita.horaInicio} | ${cita.estilista}`);
    const [waClienta, waDuena] = await Promise.all([
      enviarClienta(cita.telefono, msgReprogramacionClienta(cita)),
      enviarDuena(msgReprogramacionDuena(cita)),
    ]);
    if (!waClienta.ok && !waDuena.ok) await liberarAviso(key, "reprogramar");
    res.json({ ok: true, waClienta: { ok: waClienta.ok }, waDuena: { ok: waDuena.ok } });
  } catch (e) {
    console.error("❌ /reprogramar:", e.message);
    res.status(500).json({ error: "No se pudo procesar." });
  }
});

// ── Health check ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "✅ Servidor Visos Keratin activo", timestamp: new Date().toISOString() });
});

// ── Errores (CORS, JSON mal formado, etc.) ───────────────────────
app.use((err, req, res, next) => {
  if (err && err.message === "Origen no permitido") return res.status(403).json({ error: "Origen no permitido." });
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) return res.status(400).json({ error: "Petición inválida." });
  console.error("❌", err && err.message);
  res.status(500).json({ error: "Error interno." });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n🚀 Servidor Visos Keratin corriendo en puerto ${PORT}`));
}
module.exports = app;

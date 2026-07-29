const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Credenciales Twilio ──────────────────────────────────────────
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM     = process.env.TWILIO_WA_FROM;
const OWNER_WA    = process.env.OWNER_WA;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("❌ Faltan variables de entorno de Twilio. Configúralas en Railway.");
  process.exit(1);
}
// ────────────────────────────────────────────────────────────────

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

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
  const cancelLink = c.firebaseKey
    ? `https://visoskeratin.vercel.app?cancelar=${c.firebaseKey}`
    : `https://visoskeratin.vercel.app`;
  return (
    `✂️ *Visos Keratin* — ¡Cita confirmada!\n\n` +
    `Hola ${c.nombre} 💛\n\n` +
    `Tu cita ha sido agendada exitosamente:\n\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha}\n` +
    `🕐 *Hora:* ${c.horaInicio} – ${c.horaFin} aprox.\n\n` +
    `📌 _Recuerda asistir sin niños ni acompañantes._\n\n` +
    `❌ *¿Necesitas cancelar tu cita?*\n` +
    `Solo puedes cancelar con mínimo *5 horas de anticipación.*\n` +
    `Toca este enlace para cancelar directamente:\n` +
    `${cancelLink}\n\n` +
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
function msgCancelacionClientа(c) {
  return (
    `❌ *Visos Keratin* — Cita cancelada\n\n` +
    `Hola ${c.nombre}, tu cita ha sido cancelada:\n\n` +
    `🌿 *Servicios:* ${c.servicios}\n` +
    `👩‍🎨 *Estilista:* ${c.estilista}\n` +
    `📅 *Fecha:* ${c.fecha} a las ${c.horaInicio}\n\n` +
    `Puedes reagendar cuando quieras en nuestra app. 💜`
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

// ── Enviar Email helper (via Twilio SendGrid si está configurado) ─
async function enviarEmail(to, subject, bodyText) {
  // Email desactivado — solo se usan notificaciones WhatsApp
  console.log(`📧 Email omitido (desactivado): ${to}`);
  return { ok: false, note: "Email desactivado" };
}
// ════════════════════════════════════════════════════════════════
// ENDPOINT: Nueva cita agendada
// ════════════════════════════════════════════════════════════════
app.post("/agendar", async (req, res) => {
  const { nombre, telefono, correo, servicios, estilista, fecha, horaInicio, horaFin } = req.body;

  if (!nombre || !telefono || !servicios || !horaInicio) {
    return res.status(400).json({ error: "Faltan datos requeridos." });
  }

  const telefonoNorm = normalizarTelefono(telefono);
  const cita = { nombre, telefono: telefonoNorm, correo, servicios, estilista, fecha, horaInicio, horaFin };
  console.log(`\n🆕 Nueva cita: ${nombre} | ${servicios} | ${fecha} ${horaInicio} | Tel: ${telefonoNorm}`);

  // Incluir la clave de Firebase en el mensaje para el enlace de cancelación
  const citaConKey = { ...cita, firebaseKey: req.body.firebaseKey || '' };

  const [waClientа, waDuena] = await Promise.all([
    enviarWA(telefonoNorm, msgClientaCita(citaConKey)),
    enviarWA(OWNER_WA.replace("whatsapp:", ""), msgDuena(cita)),
  ]);

  const [emailCliente, emailOwner] = await Promise.all([
    correo ? enviarEmail(correo, `✅ Cita confirmada — Visos Keratin`, msgClientaCita(cita)) : Promise.resolve({ok:false,note:'Sin correo'}),
    enviarEmail(OWNER_EMAIL, `📅 Nueva cita: ${nombre} — ${servicios}`, msgDuena(cita))
  ]);

  res.json({ ok: true, waClientа, waDuena, emailCliente, emailOwner });
});

// ════════════════════════════════════════════════════════════════
// ENDPOINT: Cancelación de cita
// ════════════════════════════════════════════════════════════════
app.post("/cancelar", async (req, res) => {
  const { nombre, telefono, correo, servicios, estilista, fecha, horaInicio } = req.body;

  if (!nombre || !telefono) {
    return res.status(400).json({ error: "Faltan datos requeridos." });
  }

  const telefonoNorm = normalizarTelefono(telefono);
  const cita = { nombre, telefono: telefonoNorm, correo, servicios, estilista, fecha, horaInicio };
  console.log(`\n❌ Cancelación: ${nombre} | ${servicios} | ${fecha} ${horaInicio} | Tel: ${telefonoNorm}`);

  const [waClientа, waDuena] = await Promise.all([
    enviarWA(telefonoNorm, msgCancelacionClientа(cita)),
    enviarWA(OWNER_WA.replace("whatsapp:", ""), msgCancelacionDuena(cita)),
  ]);

  // Emails de cancelación
  await Promise.all([
    cita.correo ? enviarEmail(cita.correo, `❌ Cita cancelada — Visos Keratin`, msgCancelacionClientа(cita)) : Promise.resolve(),
    enviarEmail(OWNER_EMAIL, `❌ Cancelación: ${cita.nombre}`, msgCancelacionDuena(cita))
  ]);

  res.json({ ok: true, waClientа, waDuena });
});

// ── Health check ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "✅ Servidor Visos Keratin activo", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 Servidor Visos Keratin corriendo en puerto ${PORT}`));

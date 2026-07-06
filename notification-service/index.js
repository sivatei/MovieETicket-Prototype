/**
 * MovieE-Ticket — Notification Service
 * Port: 3002
 *
 * Sends email notifications only (via SendGrid in production).
 * In this prototype, emails are simulated — logged to console and saved to MySQL.
 *
 * Demonstrates:
 *   ADR-001 — Independent microservice: if this goes down, booking still works
 *   ADR-005 — Async communication: called by Booking Service fire-and-forget
 */

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
const DB_HOST = process.env.DB_HOST || "mysql";

// ── MySQL pool ────────────────────────────────────────────────────────────────
let pool;
async function getPool() {
  if (!pool) {
    pool = await mysql.createPool({
      host: DB_HOST,
      port: 3306,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "movieeticket",
      database: process.env.DB_NAME || "movieeticket_db",
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

// ── DB init ───────────────────────────────────────────────────────────────────
async function initDB() {
  const db = await getPool();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id VARCHAR(36) PRIMARY KEY,
      booking_id VARCHAR(36),
      type VARCHAR(50) NOT NULL,
      recipient_name VARCHAR(255),
      recipient_email VARCHAR(255),
      subject VARCHAR(255),
      message TEXT,
      channel VARCHAR(20) DEFAULT 'email',
      status ENUM('sent','failed') DEFAULT 'sent',
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("[DB] MySQL ready");
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ service: "notification-service", status: "ok", port: PORT });
});

// ── GET /notifications ────────────────────────────────────────────────────────
app.get("/notifications", async (_req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      "SELECT * FROM notification_logs ORDER BY sent_at DESC LIMIT 50"
    );
    res.json({ success: true, total: rows.length, notifications: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /notify ──────────────────────────────────────────────────────────────
// Called asynchronously by Booking Service after a booking is confirmed or cancelled
// In production: would call SendGrid API to send a real email
// In prototype: simulates the email by logging to console + saving to MySQL
app.post("/notify", async (req, res) => {
  const {
    booking_id,
    type = "confirmation",
    user_name,
    user_email,
    movie_name,
    show_date,
    show_time,
    theater,
    seat_number,
    category,
    total_price,
    payment_method,
  } = req.body;

  if (!user_name || !user_email) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: user_name, user_email",
    });
  }

  // Build email subject and body based on notification type
  let subject = "";
  let message = "";

  if (type === "cancellation") {
    subject = "Your MovieE-Ticket Booking Has Been Cancelled";
    message =
      `Dear ${user_name},\n\n` +
      `Your booking (ID: ${booking_id}) has been successfully cancelled.\n` +
      `A refund will be processed to your original payment method shortly.\n\n` +
      `Thank you for using MovieE-Ticket.\n\n` +
      `[In production: this email would be sent to ${user_email} via SendGrid]`;
  } else {
    subject = "Your MovieE-Ticket Booking Confirmation";
    message =
      `Dear ${user_name},\n\n` +
      `Your booking is confirmed! Here are your details:\n\n` +
      `  Movie   : ${movie_name}\n` +
      `  Date    : ${new Date(show_date).toDateString()}\n` +
      `  Time    : ${show_time}\n` +
      `  Theater : ${theater}\n` +
      `  Seat    : ${seat_number} (${category})\n` +
      `  Price   : $${total_price}\n` +
      `  Payment : ${payment_method}\n` +
      `  Booking ID: ${booking_id}\n\n` +
      `Please present this confirmation at the cinema entrance.\n\n` +
      `Thank you for using MovieE-Ticket.\n\n` +
      `[In production: this email would be sent to ${user_email} via SendGrid]`;
  }

  // Simulate sending email — log to console
  console.log("\n================================================");
  console.log(`[Notification Service] EMAIL - ${type.toUpperCase()}`);
  console.log(`  To      : ${user_name} <${user_email}>`);
  console.log(`  Subject : ${subject}`);
  console.log(`  Channel : Email (SendGrid)`);
  console.log(`  Body    :\n${message}`);
  console.log("================================================\n");

  // Save notification log to MySQL
  const notifId = uuidv4();
  try {
    const db = await getPool();
    await db.execute(
      `INSERT INTO notification_logs
         (id, booking_id, type, recipient_name, recipient_email, subject, message, channel, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'email', 'sent')`,
      [notifId, booking_id || null, type, user_name, user_email, subject, message]
    );
  } catch (dbErr) {
    console.warn("[DB] Could not save notification log:", dbErr.message);
  }

  res.status(200).json({
    success: true,
    message: "Email notification sent successfully",
    notification: {
      id: notifId,
      booking_id,
      type,
      channel: "email",
      recipient: user_email,
      subject,
      status: "sent",
    },
    demo_notes: {
      "ADR-005": "This service was called asynchronously by Booking Service — booking was already confirmed before this ran",
      "ADR-001": "This service is independent — if it goes down, Booking Service continues to work normally",
      production_note: "In production, this calls the SendGrid API to deliver a real email to the user",
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Notification Service] Running on port ${PORT}`);
  let attempts = 0;
  const tryInit = async () => {
    try { await initDB(); }
    catch { if (attempts++ < 10) setTimeout(tryInit, 3000); }
  };
  setTimeout(tryInit, 2000);
});

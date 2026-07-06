/**
 * MovieE-Ticket — Seat Booking & Cancel Service
 * Port: 3001
 *
 * Demonstrates:
 *   ADR-001 — Microservices: this is one independent deployable service
 *   ADR-003 — MySQL (ACID transactions + row-level locking for seat booking)
 *   ADR-004 — Redis TTL seat lock (prevents double-booking)
 *   ADR-005 — Async notification: Booking calls Notification fire-and-forget
 */

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const Redis = require("ioredis");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || "http://notification-service:3002";
const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const DB_HOST = process.env.DB_HOST || "mysql";

// ── Redis client ──────────────────────────────────────────────────────────────
let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true });
    redis.on("error", (e) => console.warn("[Redis] error:", e.message));
  }
  return redis;
}

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
      connectionLimit: 10,
    });
  }
  return pool;
}

// ── DB initialisation + seed ──────────────────────────────────────────────────
async function initDB() {
  const db = await getPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS showtimes (
      id VARCHAR(36) PRIMARY KEY,
      movie_name VARCHAR(255) NOT NULL,
      show_date DATE NOT NULL,
      show_time TIME NOT NULL,
      theater VARCHAR(100) NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS seats (
      id VARCHAR(36) PRIMARY KEY,
      showtime_id VARCHAR(36) NOT NULL,
      seat_number VARCHAR(10) NOT NULL,
      category ENUM('normal','premium','vip') DEFAULT 'normal',
      price DECIMAL(10,2) NOT NULL,
      is_booked BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (showtime_id) REFERENCES showtimes(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bookings (
      id VARCHAR(36) PRIMARY KEY,
      showtime_id VARCHAR(36) NOT NULL,
      seat_id VARCHAR(36) NOT NULL,
      user_name VARCHAR(255) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      payment_method VARCHAR(50) NOT NULL,
      total_price DECIMAL(10,2) NOT NULL,
      status ENUM('confirmed','cancelled') DEFAULT 'confirmed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (showtime_id) REFERENCES showtimes(id),
      FOREIGN KEY (seat_id) REFERENCES seats(id)
    )
  `);

  // Seed only if empty
  const [rows] = await db.execute("SELECT COUNT(*) AS count FROM showtimes");
  if (rows[0].count === 0) {
    const st1 = uuidv4(), st2 = uuidv4();
    await db.execute(
      "INSERT INTO showtimes (id,movie_name,show_date,show_time,theater) VALUES (?,?,?,?,?)",
      [st1, "Avengers: Doomsday", "2026-07-10", "18:00:00", "Cinema 1"]
    );
    await db.execute(
      "INSERT INTO showtimes (id,movie_name,show_date,show_time,theater) VALUES (?,?,?,?,?)",
      [st2, "Mission Impossible 8", "2026-07-10", "20:00:00", "Cinema 2"]
    );
    const seats = [
      ["A1","normal",5.00], ["A2","normal",5.00], ["A3","normal",5.00],
      ["B1","premium",8.00], ["B2","premium",8.00],
      ["C1","vip",12.00],   ["C2","vip",12.00],
    ];
    for (const [num, cat, price] of seats) {
      await db.execute(
        "INSERT INTO seats (id,showtime_id,seat_number,category,price) VALUES (?,?,?,?,?)",
        [uuidv4(), st1, num, cat, price]
      );
      await db.execute(
        "INSERT INTO seats (id,showtime_id,seat_number,category,price) VALUES (?,?,?,?,?)",
        [uuidv4(), st2, num, cat, price]
      );
    }
    console.log("[DB] Sample data seeded");
  }
  console.log("[DB] MySQL ready");
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ service: "booking-service", status: "ok", port: PORT });
});

// ── GET /showtimes ────────────────────────────────────────────────────────────
app.get("/showtimes", async (_req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute("SELECT * FROM showtimes ORDER BY show_date, show_time");
    res.json({ success: true, showtimes: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /showtimes/:id/seats ──────────────────────────────────────────────────
app.get("/showtimes/:id/seats", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getPool();
    const r = getRedis();

    const [showtime] = await db.execute("SELECT * FROM showtimes WHERE id = ?", [id]);
    if (!showtime.length) return res.status(404).json({ success: false, error: "Showtime not found" });

    const [seats] = await db.execute(
      "SELECT * FROM seats WHERE showtime_id = ? ORDER BY seat_number", [id]
    );

    const seatsWithStatus = await Promise.all(seats.map(async (seat) => {
      let locked = false;
      try { locked = !!(await r.get(`seat_lock:${seat.id}`)); } catch (_) {}
      return {
        ...seat,
        status: seat.is_booked ? "booked" : locked ? "temporarily_held" : "available",
      };
    }));

    res.json({ success: true, showtime: showtime[0], seats: seatsWithStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /bookings ────────────────────────────────────────────────────────────
app.post("/bookings", async (req, res) => {
  const { showtime_id, seat_id, user_name, user_email, payment_method } = req.body;

  if (!showtime_id || !seat_id || !user_name || !user_email || !payment_method) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: showtime_id, seat_id, user_name, user_email, payment_method",
    });
  }

  const db = await getPool();
  const r = getRedis();
  const lockKey = `seat_lock:${seat_id}`;
  const bookingId = uuidv4();

  // Step 1 — Acquire Redis seat lock (ADR-004)
  let lockAcquired = false;
  try {
    lockAcquired = (await r.set(lockKey, bookingId, "EX", 600, "NX")) === "OK";
  } catch (_) {
    lockAcquired = true; // Redis unavailable — fall back to DB lock only
    console.warn("[Redis] unavailable, relying on DB transaction only");
  }

  if (!lockAcquired) {
    return res.status(409).json({
      success: false,
      error: "Seat is temporarily held by another user. Please try again in a few minutes.",
      demo_note: "ADR-004: Redis TTL seat lock prevented double-booking",
    });
  }

  // Step 2 — MySQL transaction (ADR-003)
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [seats] = await conn.execute(
      "SELECT * FROM seats WHERE id = ? AND showtime_id = ? FOR UPDATE",
      [seat_id, showtime_id]
    );
    if (!seats.length) throw new Error("Seat not found for this showtime");
    if (seats[0].is_booked) throw new Error("Seat is already booked");

    await conn.execute("UPDATE seats SET is_booked = TRUE WHERE id = ?", [seat_id]);
    await conn.execute(
      "INSERT INTO bookings (id,showtime_id,seat_id,user_name,user_email,payment_method,total_price) VALUES (?,?,?,?,?,?,?)",
      [bookingId, showtime_id, seat_id, user_name, user_email, payment_method, seats[0].price]
    );
    await conn.commit();
    conn.release();

    // Step 3 — Trigger Notification Service async (ADR-005)
    const [st] = await db.execute("SELECT * FROM showtimes WHERE id = ?", [showtime_id]);
    axios.post(`${NOTIFICATION_URL}/notify`, {
      booking_id: bookingId,
      user_name,
      user_email,
      movie_name: st[0]?.movie_name,
      show_date: st[0]?.show_date,
      show_time: st[0]?.show_time,
      theater: st[0]?.theater,
      seat_number: seats[0].seat_number,
      category: seats[0].category,
      total_price: seats[0].price,
      payment_method,
    })
    .then(() => console.log(`[Booking] Notification triggered for booking ${bookingId}`))
    .catch((e) => console.warn(`[Booking] Notification failed (non-critical): ${e.message}`));

    return res.status(201).json({
      success: true,
      message: "Booking confirmed successfully",
      booking: {
        id: bookingId,
        showtime_id,
        seat_id,
        seat_number: seats[0].seat_number,
        category: seats[0].category,
        user_name,
        user_email,
        payment_method,
        total_price: seats[0].price,
        status: "confirmed",
      },
      demo_notes: {
        "ADR-003": "MySQL ACID transaction used — row-level locking prevents double-booking at DB level",
        "ADR-004": "Redis seat lock acquired before DB write — 600s TTL",
        "ADR-005": "Notification Service called asynchronously — booking confirmed without waiting for email",
      },
    });
  } catch (txErr) {
    await conn.rollback();
    conn.release();
    try { await r.del(lockKey); } catch (_) {}
    return res.status(500).json({ success: false, error: txErr.message });
  }
});

// ── GET /bookings ─────────────────────────────────────────────────────────────
app.get("/bookings", async (_req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(`
      SELECT b.*, s.movie_name, s.show_date, s.show_time, s.theater,
             se.seat_number, se.category
      FROM bookings b
      JOIN showtimes s  ON b.showtime_id = s.id
      JOIN seats se     ON b.seat_id     = se.id
      ORDER BY b.created_at DESC
    `);
    res.json({ success: true, bookings: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /bookings/:id ──────────────────────────────────────────────────────
app.delete("/bookings/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getPool();
    const [rows] = await db.execute("SELECT * FROM bookings WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: "Booking not found" });

    await db.execute("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [id]);
    await db.execute("UPDATE seats SET is_booked = FALSE WHERE id = ?", [rows[0].seat_id]);

    const r = getRedis();
    try { await r.del(`seat_lock:${rows[0].seat_id}`); } catch (_) {}

    axios.post(`${NOTIFICATION_URL}/notify`, {
      type: "cancellation",
      booking_id: id,
      user_name: rows[0].user_name,
      user_email: rows[0].user_email,
    }).catch((e) => console.warn("[Booking] Cancellation notification failed:", e.message));

    res.json({ success: true, message: "Booking cancelled successfully", booking_id: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Booking Service] Running on port ${PORT}`);
  let attempts = 0;
  const tryInit = async () => {
    try { await initDB(); }
    catch { if (attempts++ < 10) setTimeout(tryInit, 3000); }
  };
  setTimeout(tryInit, 2000);
});

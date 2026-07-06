# MovieE-Ticket — Movie Ticket Booking System (Prototype)

**FESE209 Software Design — Final Project**  
**Team:** Sivatey · Sveita · Sokhomal · Sonita  
**Instructor:** Pen Voneat  
**Submission:** 06 July 2026

---

## What This Prototype Demonstrates

This prototype runs **2 of the 6 microservices** defined in our System Architecture Document (SAD). These two services demonstrate the most critical architectural decisions from our C&C diagram and ADRs.

| Service | Port | Maps to SAD C&C Diagram |
|---|---|---|
| Booking Service | 3001 | Seat Booking & Cancel Service |
| Notification Service | 3002 | Notification Service (email only) |

### ADRs demonstrated by the running code

| ADR | Decision | Where to see it in the prototype |
|---|---|---|
| ADR-001 | Microservices over Modular Monolith | Two services start and run independently — Notification can go down without stopping Booking |
| ADR-003 | MySQL for Booking (ACID transactions) | POST /bookings uses a MySQL transaction with FOR UPDATE row-level locking |
| ADR-004 | Redis seat-lock TTL (prevent double-booking) | Book the same seat twice — second request returns 409 Conflict immediately |
| ADR-005 | Async email notification (fire-and-forget) | POST /bookings returns instantly; email notification appears in logs after |

### Notification channel
Email only — simulates a SendGrid API call. In production, the Notification Service would call the SendGrid API with the user's email address to deliver a real booking confirmation. No SMS is used in this system.

---

## How to Run

### Requirements
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — installed and running

### Start all services
```bash
docker compose up --build
```

Wait ~30 seconds for MySQL to initialise. Success looks like:
```
[Booking Service] Running on port 3001
[Notification Service] Running on port 3002
[DB] MySQL ready
[DB] Sample data seeded
```

### Stop
```bash
docker compose down
```

### Full reset (clears all booking data)
```bash
docker compose down -v
docker compose up --build
```

---

## API Endpoints

### Booking Service — http://localhost:3001

| Method | Endpoint | Description |
|---|---|---|
| GET | /health | Service health check |
| GET | /showtimes | List all showtimes |
| GET | /showtimes/:id/seats | Seat map with live availability |
| POST | /bookings | Create a booking |
| GET | /bookings | List all bookings |
| DELETE | /bookings/:id | Cancel a booking |

### Notification Service — http://localhost:3002

| Method | Endpoint | Description |
|---|---|---|
| GET | /health | Service health check |
| POST | /notify | Receive notification trigger (email) |
| GET | /notifications | View all email notification logs |

---

## Step-by-Step Demo for Graders

### 1 — Confirm both services run independently (ADR-001)
```
GET http://localhost:3001/health  →  { "status": "ok" }
GET http://localhost:3002/health  →  { "status": "ok" }
```

### 2 — Browse showtimes
```
GET http://localhost:3001/showtimes
```
Returns 2 seeded movies. Copy a `showtime id`.

### 3 — Check seat availability
```
GET http://localhost:3001/showtimes/{showtime_id}/seats
```
Shows 7 seats per showtime. Status: `available`, `temporarily_held` (Redis lock), `booked`.  
Copy an `available` seat's `id`.

### 4 — Create a booking (main demo)
```
POST http://localhost:3001/bookings
Body:
{
  "showtime_id": "<from step 2>",
  "seat_id": "<from step 3>",
  "user_name": "Sivatey Kim",
  "user_email": "sivatey@example.com",
  "payment_method": "ABA Pay"
}
```
Response confirms booking immediately. Note the `demo_notes` field — it names which ADR each step demonstrates.

### 5 — Verify async email notification (ADR-005)
```
GET http://localhost:3002/notifications
```
An email notification record appears — logged AFTER the booking response returned.  
Check the Docker logs window — you will also see the full email body printed there.

### 6 — Prove double-booking prevention (ADR-004)
Send the same POST /bookings request with the **same seat_id**:
```
Response: 409 Conflict
{ "error": "Seat is temporarily held by another user",
  "demo_note": "ADR-004: Redis TTL seat lock prevented double-booking" }
```

### 7 — Cancel a booking
```
DELETE http://localhost:3001/bookings/{booking_id}
```
Seat returns to available. Cancellation email notification fires asynchronously.

---

## Architecture Alignment

### How this maps to our C&C diagram
```
[Client / Postman]
       |
       | HTTPS
       ↓
[API Gateway] ← simulated by direct service calls in this prototype
       |
       | REST (sync)
       ↓
[Booking Service :3001]
       |                    \
       | reads/writes        \ Redis seat lock TTL (ADR-004)
       ↓                      ↓
  [MySQL DB]            [Redis Cache]
       |
       | async HTTP (fire-and-forget) — ADR-005
       ↓
[Notification Service :3002]
       |
       | reads/writes
       ↓
  [MySQL DB]
       |
       | (in production)
       ↓
[SendGrid — email delivery]
```

---

## Submission Files

```
MovieE-Ticket/
├── docker-compose.yml                  ← starts everything with one command
├── README.md                           ← this file
├── MovieETicket_Postman_Collection.json ← import into Postman for testing
├── booking-service/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js
└── notification-service/
    ├── Dockerfile
    ├── package.json
    └── index.js
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Services | Node.js + Express |
| Database | MySQL 8.0 (ACID transactions) |
| Seat Lock Cache | Redis 7 (TTL-based hold) |
| Email Notification | SendGrid (simulated in prototype) |
| Containerisation | Docker Compose |
| API Testing | Postman |

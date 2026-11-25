# MovieE-Ticket — Movie Ticket Booking System

A course project prototype demonstrating a microservices-based movie ticket booking system. The repository currently implements two services from the wider system design: Booking and Notification.

## Implemented services
| Service | Port | Responsibility |
|---|---:|---|
| Booking Service | 3001 | Showtimes, seat availability, booking, and cancellation |
| Notification Service | 3002 | Receives booking events and records simulated email notifications |

## Architecture concepts
- **Independent services:** Booking and Notification run as separate Node.js services.
- **MySQL:** Relational storage for showtimes, seats, bookings, and notification logs.
- **Redis:** Temporary seat locks with a time-to-live to help prevent double booking.
- **Asynchronous notification:** Booking triggers notification processing without waiting for real email delivery.

The notification service simulates email delivery in this prototype; it does not send real email through SendGrid.

## Tech stack
- Node.js and Express
- MySQL 8
- Redis
- Docker Compose
- Postman for API testing

## Run locally
Requirements: Docker Desktop with Docker Compose.

```bash
docker compose up --build
```

Services:
- Booking Service: `http://localhost:3001`
- Notification Service: `http://localhost:3002`

Stop containers with `docker compose down`. To reset local prototype data, run `docker compose down -v` and then `docker compose up --build`.

## API overview
The Booking Service provides health, showtime, seat-map, booking, and cancellation endpoints. The Notification Service provides health, notification-trigger, and notification-log endpoints. See the API documentation and Postman collection for request details.

## Team project
This was developed as a team course project. Individual responsibilities should be described separately from the overall team implementation so readers can understand each member's contribution.

This repository is a prototype implementing two services from a larger six-service design. It is intended for learning and demonstration, not production deployment.

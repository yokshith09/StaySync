import test from "node:test";
import assert from "node:assert/strict";
import { createStaySyncApp } from "../src/app.js";

test("room search returns rooms that fit the requested guest count", async () => {
  const app = createStaySyncApp();
  const response = await app.fetch(new Request("http://localhost/api/rooms?checkIn=2026-12-10&checkOut=2026-12-12&guests=2"));

  assert.equal(response.status, 200);
  assert.ok((await response.json()).rooms.every((room) => room.capacity >= 2));
});

test("an overlapping reservation hold returns a conflict and a structured event", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });
  const body = JSON.stringify({ roomId: "room-harbor-king", checkIn: "2026-12-10", checkOut: "2026-12-12", guestCount: 2 });

  const first = await app.fetch(new Request("http://localhost/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body }));
  const second = await app.fetch(new Request("http://localhost/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body }));

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "RESERVATION_CONFLICT");
  assert.equal(logs.at(-1).event, "reservation_conflict");
  assert.equal(logs.at(-1).severity, "WARNING");
  assert.ok(logs.at(-1).requestId);
});

test("an approved simulated payment confirms its held reservation and requests confirmation", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });
  const hold = await app.fetch(new Request("http://localhost/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: "room-city-twin", checkIn: "2026-12-15", checkOut: "2026-12-17", guestCount: 2 }) }));
  const { reservation } = await hold.json();

  const response = await app.fetch(new Request("http://localhost/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reservationId: reservation.id }) }));

  assert.equal(response.status, 201);
  assert.equal((await response.json()).reservation.status, "CONFIRMED");
  assert.equal(logs.at(-1).event, "confirmation_requested");
});

test("staff can check in a confirmed reservation", async () => {
  const app = createStaySyncApp();
  const hold = await app.fetch(new Request("http://localhost/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: "room-garden-suite", checkIn: "2026-12-19", checkOut: "2026-12-21", guestCount: 2 }) }));
  const { reservation } = await hold.json();
  await app.fetch(new Request("http://localhost/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reservationId: reservation.id }) }));
  const response = await app.fetch(new Request(`http://localhost/api/reservations/${reservation.id}/check-in`, { method: "PATCH" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reservation.status, "CHECKED_IN");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createStaySyncApp } from "../src/app.js";
import { createConfirmationWorker } from "../src/worker.js";
import { createStaySyncStore } from "../src/store.js";

async function getStaffToken(app) {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staff@staysync.internal", password: "DeskPass2026!" })
    })
  );
  const data = await res.json();
  return data.token;
}

test("room search returns rooms that fit the requested guest count", async () => {
  const app = createStaySyncApp();
  const response = await app.fetch(
    new Request("http://localhost/api/rooms?checkIn=2026-12-10&checkOut=2026-12-12&guests=2")
  );

  assert.equal(response.status, 200);
  assert.ok((await response.json()).rooms.every((room) => room.capacity >= 2));
});

test("an overlapping reservation hold returns a conflict and a structured event", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });
  const body = JSON.stringify({ roomId: "room-harbor-king", checkIn: "2026-12-10", checkOut: "2026-12-12", guestCount: 2 });

  const first = await app.fetch(
    new Request("http://localhost/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body })
  );
  const second = await app.fetch(
    new Request("http://localhost/api/reservations", { method: "POST", headers: { "content-type": "application/json" }, body })
  );

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
  const hold = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-city-twin", checkIn: "2026-12-15", checkOut: "2026-12-17", guestCount: 2 })
    })
  );
  const { reservation } = await hold.json();

  const response = await app.fetch(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reservationId: reservation.id })
    })
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).reservation.status, "CONFIRMED");
  assert.equal(logs.at(-1).event, "confirmation_requested");
});

test("the payment failure scenario returns a 502 and an ERROR log without confirming the booking", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });
  const hold = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-city-twin", checkIn: "2026-12-23", checkOut: "2026-12-25", guestCount: 2 })
    })
  );
  const { reservation } = await hold.json();
  const response = await app.fetch(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-scenario": "payment_failure" },
      body: JSON.stringify({ reservationId: reservation.id })
    })
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PAYMENT_PROVIDER_REJECTED");
  assert.equal(logs.at(-1).event, "payment_provider_rejected");
  assert.equal(logs.at(-1).severity, "ERROR");
  assert.equal(logs.at(-1).statusCode, 502);
});

test("slow payment and database timeout scenarios produce diagnosable telemetry", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });
  const hold = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-garden-suite", checkIn: "2026-12-26", checkOut: "2026-12-28", guestCount: 2 })
    })
  );
  const { reservation } = await hold.json();
  const payment = await app.fetch(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-scenario": "slow_payment" },
      body: JSON.stringify({ reservationId: reservation.id })
    })
  );
  const timeout = await app.fetch(
    new Request("http://localhost/api/rooms?checkIn=2026-12-29&checkOut=2026-12-31&guests=2", {
      headers: { "x-demo-scenario": "database_timeout" }
    })
  );

  assert.equal(payment.status, 201);
  assert.equal(logs.at(-2).event, "payment_slow");
  assert.equal(logs.at(-2).severity, "WARNING");
  assert.ok(logs.at(-2).responseTimeMs >= 100);
  assert.equal(timeout.status, 503);
  assert.equal(logs.at(-1).event, "database_timeout");
  assert.equal(logs.at(-1).severity, "ERROR");
});

test("authentication verifies credentials and creates a session token", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });

  // Valid staff login
  const loginRes = await app.fetch(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staff@staysync.internal", password: "DeskPass2026!" })
    })
  );
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(loginData.token);
  assert.equal(loginData.user.role, "staff");
  assert.equal(logs.at(-1).event, "auth_login_success");

  // Invalid password
  const failRes = await app.fetch(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staff@staysync.internal", password: "WrongPassword!" })
    })
  );
  assert.equal(failRes.status, 401);
  assert.equal(logs.at(-1).event, "auth_login_failed");
  assert.equal(logs.at(-1).severity, "WARNING");
});

test("guest registration creates an account and prevents duplicates", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });

  const regRes = await app.fetch(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Elena Rostova", email: "elena@example.com", password: "Password2026!" })
    })
  );
  assert.equal(regRes.status, 201);
  const data = await regRes.json();
  assert.ok(data.token);
  assert.equal(data.user.email, "elena@example.com");
  assert.equal(data.user.role, "guest");
  assert.equal(logs.at(-1).event, "auth_register_success");

  // Duplicate registration
  const dupRes = await app.fetch(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Elena Duplicate", email: "elena@example.com", password: "Password2026!" })
    })
  );
  assert.equal(dupRes.status, 409);
  assert.equal((await dupRes.json()).error.code, "EMAIL_EXISTS");
  assert.equal(logs.at(-1).event, "auth_register_duplicate");
});

test("unauthorized access to hotel desk is blocked and logged", async () => {
  const logs = [];
  const app = createStaySyncApp({ writeLog: (entry) => logs.push(entry) });

  // Accessing /api/reservations without staff credentials
  const res = await app.fetch(new Request("http://localhost/api/reservations"));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "FORBIDDEN");
  assert.equal(logs.at(-1).event, "auth_unauthorized_access");
  assert.equal(logs.at(-1).severity, "WARNING");
});

test("staff can view desk reservations and check in a confirmed reservation", async () => {
  const store = createStaySyncStore();
  const app = createStaySyncApp({ store });
  const staffToken = await getStaffToken(app);

  const hold = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-garden-suite", checkIn: "2026-12-19", checkOut: "2026-12-21", guestCount: 2 })
    })
  );
  const { reservation } = await hold.json();
  await app.fetch(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reservationId: reservation.id })
    })
  );

  // Staff lists reservations
  const listRes = await app.fetch(
    new Request("http://localhost/api/reservations", {
      headers: { authorization: `Bearer ${staffToken}` }
    })
  );
  assert.equal(listRes.status, 200);
  assert.ok((await listRes.json()).reservations.length > 0);

  // Staff checks in
  const checkInRes = await app.fetch(
    new Request(`http://localhost/api/reservations/${reservation.id}/check-in`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${staffToken}` }
    })
  );
  assert.equal(checkInRes.status, 200);
  assert.equal((await checkInRes.json()).reservation.status, "CHECKED_IN");
});

test("guests can cancel reservations, releasing availability", async () => {
  const logs = [];
  const store = createStaySyncStore();
  const app = createStaySyncApp({ store, writeLog: (entry) => logs.push(entry) });

  const hold = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-harbor-king", checkIn: "2027-03-01", checkOut: "2027-03-03", guestCount: 2 })
    })
  );
  const { reservation } = await hold.json();

  const cancelRes = await app.fetch(
    new Request(`http://localhost/api/reservations/${reservation.id}/cancel`, { method: "POST" })
  );
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json()).reservation.status, "CANCELLED");
  assert.equal(logs.at(-1).event, "reservation_cancelled");

  // Re-booking the same room for the same dates should now SUCCEED
  const rebookRes = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-harbor-king", checkIn: "2027-03-01", checkOut: "2027-03-03", guestCount: 2 })
    })
  );
  assert.equal(rebookRes.status, 201);
});

test("housekeeping status prevents booking and emits cleaning telemetry", async () => {
  const logs = [];
  const store = createStaySyncStore();
  const app = createStaySyncApp({ store, writeLog: (entry) => logs.push(entry) });
  const staffToken = await getStaffToken(app);

  // Set room to CLEANING
  const patchRes = await app.fetch(
    new Request("http://localhost/api/rooms/room-city-twin/housekeeping", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${staffToken}` },
      body: JSON.stringify({ housekeepingStatus: "CLEANING" })
    })
  );
  assert.equal(patchRes.status, 200);

  // Attempting to hold this room should now fail with 409 ROOM_UNDER_CLEANING
  const holdRes = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-city-twin", checkIn: "2027-04-10", checkOut: "2027-04-12", guestCount: 2 })
    })
  );
  assert.equal(holdRes.status, 409);
  assert.equal((await holdRes.json()).error.code, "ROOM_UNDER_CLEANING");
  assert.equal(logs.at(-1).event, "room_unavailable_cleaning");
});

test("confirmation worker processes outbox events and logs telemetry", async () => {
  const logs = [];
  const store = createStaySyncStore();
  const app = createStaySyncApp({ store });
  const worker = createConfirmationWorker({ store, writeLog: (entry) => logs.push(entry) });

  const hold = await app.fetch(
    new Request("http://localhost/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-harbor-king", checkIn: "2027-02-01", checkOut: "2027-02-03", guestCount: 2 })
    })
  );
  const { reservation } = await hold.json();
  await app.fetch(
    new Request("http://localhost/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reservationId: reservation.id })
    })
  );

  const pending = await store.getOutboxEvents({ unpublishedOnly: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventType, "booking.confirmation.requested");

  // Process outbox
  const results = await worker.processPendingOutbox();
  assert.equal(results[0].status, "processed");
  assert.equal(logs.at(-1).event, "confirmation_sent");
  assert.equal(logs.at(-1).severity, "INFO");
});

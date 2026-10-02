import pg from "pg";
import { defaultSeedUsers, hashPassword, verifyPassword, generateToken, hashToken } from "./auth.js";

const { Pool } = pg;

const seedRooms = [
  { id: "room-harbor-king", hotel: "Harbor House", name: "Harbor King", capacity: 2, nightlyRateCents: 18400, housekeepingStatus: "READY" },
  { id: "room-garden-suite", hotel: "Harbor House", name: "Garden Suite", capacity: 4, nightlyRateCents: 26500, housekeepingStatus: "READY" },
  { id: "room-city-twin", hotel: "City House", name: "City Twin", capacity: 2, nightlyRateCents: 14900, housekeepingStatus: "READY" }
];

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function createStaySyncStore() {
  const rooms = new Map(seedRooms.map((room) => [room.id, { ...room }]));
  const reservations = new Map();
  const users = new Map(defaultSeedUsers.map((user) => [user.id, { ...user }]));
  const sessions = new Map();
  const outbox = [];

  return {
    async registerUser({ email, password, name }) {
      const existing = [...users.values()].find((u) => u.email.toLowerCase() === email?.toLowerCase());
      if (existing) return { kind: "email_exists" };

      const { hash, salt } = hashPassword(password);
      const user = {
        id: `user-${crypto.randomUUID().slice(0, 8)}`,
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role: "guest",
        hash,
        salt,
        createdAt: new Date().toISOString()
      };
      users.set(user.id, user);
      const session = await this.createSession(user.id);
      return { kind: "created", user: { id: user.id, email: user.email, name: user.name, role: user.role }, token: session.token };
    },

    async authenticateUser({ email, password }) {
      const user = [...users.values()].find((u) => u.email.toLowerCase() === email?.toLowerCase());
      if (!user) return null;
      const isValid = verifyPassword(password ?? "", user.salt, user.hash);
      if (!isValid) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    },

    async createSession(userId) {
      const user = users.get(userId);
      if (!user) return null;
      const { rawToken, tokenHash } = generateToken();
      const session = {
        id: crypto.randomUUID(),
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };
      sessions.set(tokenHash, session);
      return { token: rawToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    },

    async getUserByToken(rawToken) {
      if (!rawToken) return null;
      const tokenHash = hashToken(rawToken);
      const session = sessions.get(tokenHash);
      if (!session) return null;
      if (new Date(session.expiresAt) < new Date()) {
        sessions.delete(tokenHash);
        return null;
      }
      const user = users.get(session.userId);
      return user ? { id: user.id, email: user.email, name: user.name, role: user.role } : null;
    },

    async deleteSession(rawToken) {
      if (!rawToken) return;
      const tokenHash = hashToken(rawToken);
      sessions.delete(tokenHash);
    },

    async searchRooms({ checkIn, checkOut, guestCount }) {
      return [...rooms.values()].filter((room) =>
        room.capacity >= guestCount &&
        room.housekeepingStatus === "READY" &&
        ![...reservations.values()].some((res) =>
          res.roomId === room.id &&
          ["HELD", "CONFIRMED"].includes(res.status) &&
          overlaps(checkIn, checkOut, res.checkIn, res.checkOut)
        )
      ).map((room) => ({ ...room }));
    },

    async listAllRooms() {
      return [...rooms.values()].map((r) => ({ ...r }));
    },

    async createHold({ roomId, checkIn, checkOut, guestCount, userId = null }) {
      const room = rooms.get(roomId);
      if (!room) return { kind: "room_not_found" };
      if (room.capacity < guestCount) return { kind: "capacity_exceeded" };
      if (
        room.housekeepingStatus !== "READY" ||
        [...reservations.values()].some((res) =>
          res.roomId === roomId &&
          ["HELD", "CONFIRMED"].includes(res.status) &&
          overlaps(checkIn, checkOut, res.checkIn, res.checkOut)
        )
      ) {
        return { kind: "conflict", housekeepingStatus: room.housekeepingStatus };
      }
      const reservation = {
        id: crypto.randomUUID(),
        roomId,
        userId,
        checkIn,
        checkOut,
        guestCount,
        status: "HELD",
        createdAt: new Date().toISOString()
      };
      reservations.set(reservation.id, reservation);
      return { kind: "created", reservation: { ...reservation }, room: { ...room } };
    },

    async confirmReservation(reservationId) {
      const reservation = reservations.get(reservationId);
      if (!reservation) return { kind: "not_found" };
      if (reservation.status !== "HELD") return { kind: "invalid_state" };
      reservation.status = "CONFIRMED";
      const payment = { id: crypto.randomUUID(), reservationId, status: "APPROVED" };
      const event = {
        id: crypto.randomUUID(),
        eventType: "booking.confirmation.requested",
        aggregateId: reservationId,
        payload: { reservationId, roomId: reservation.roomId, status: "CONFIRMED" },
        publishedAt: null,
        createdAt: new Date().toISOString()
      };
      outbox.push(event);
      return { kind: "confirmed", reservation: { ...reservation }, payment, event };
    },

    async cancelReservation(reservationId, { userId = null, role = "guest" } = {}) {
      const reservation = reservations.get(reservationId);
      if (!reservation) return { kind: "not_found" };
      if (role !== "staff" && reservation.userId && reservation.userId !== userId) {
        return { kind: "forbidden" };
      }
      if (["CANCELLED", "CHECKED_IN", "CHECKED_OUT"].includes(reservation.status)) {
        return { kind: "invalid_state", currentStatus: reservation.status };
      }
      reservation.status = "CANCELLED";
      const event = {
        id: crypto.randomUUID(),
        eventType: "booking.cancelled",
        aggregateId: reservationId,
        payload: { reservationId, roomId: reservation.roomId, status: "CANCELLED" },
        publishedAt: null,
        createdAt: new Date().toISOString()
      };
      outbox.push(event);
      return { kind: "cancelled", reservation: { ...reservation } };
    },

    async listReservations({ userId = null, role = "staff" } = {}) {
      let list = [...reservations.values()];
      if (role !== "staff" && userId) {
        list = list.filter((res) => res.userId === userId);
      }
      return list.map((res) => ({ ...res, room: { ...rooms.get(res.roomId) } }));
    },

    async checkIn(reservationId) {
      const reservation = reservations.get(reservationId);
      if (!reservation) return { kind: "not_found" };
      if (reservation.status !== "CONFIRMED") return { kind: "invalid_state" };
      reservation.status = "CHECKED_IN";
      return { kind: "updated", reservation: { ...reservation } };
    },

    async updateHousekeeping(roomId, housekeepingStatus) {
      const room = rooms.get(roomId);
      if (!room) return { kind: "not_found" };
      room.housekeepingStatus = housekeepingStatus;
      return { kind: "updated", room: { ...room } };
    },

    async getOutboxEvents({ unpublishedOnly = true } = {}) {
      return unpublishedOnly ? outbox.filter((e) => !e.publishedAt) : [...outbox];
    },

    async markOutboxPublished(eventId) {
      const ev = outbox.find((e) => e.id === eventId);
      if (ev) ev.publishedAt = new Date().toISOString();
    }
  };
}

export function createPostgresStore(connectionString) {
  const pool = new Pool({ connectionString });

  return {
    async registerUser({ email, password, name }) {
      const { hash, salt } = hashPassword(password);
      const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await pool.query(
          "INSERT INTO users (id, email, password_hash, salt, role, full_name) VALUES ($1, $2, $3, $4, 'guest', $5)",
          [userId, email.trim().toLowerCase(), hash, salt, name.trim()]
        );
        const session = await this.createSession(userId);
        return {
          kind: "created",
          user: { id: userId, email: email.trim().toLowerCase(), name: name.trim(), role: "guest" },
          token: session.token
        };
      } catch (err) {
        if (err.code === "23505") return { kind: "email_exists" };
        throw err;
      }
    },

    async authenticateUser({ email, password }) {
      const { rows } = await pool.query(
        "SELECT id, email, full_name as name, role, password_hash, salt FROM users WHERE LOWER(email) = LOWER($1)",
        [email]
      );
      const user = rows[0];
      if (!user) return null;
      const isValid = verifyPassword(password ?? "", user.salt, user.password_hash);
      if (!isValid) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    },

    async createSession(userId) {
      const { rawToken, tokenHash } = generateToken();
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        [id, userId, tokenHash, expiresAt]
      );
      const { rows } = await pool.query("SELECT id, email, full_name as name, role FROM users WHERE id = $1", [userId]);
      return { token: rawToken, user: rows[0] };
    },

    async getUserByToken(rawToken) {
      if (!rawToken) return null;
      const tokenHash = hashToken(rawToken);
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.full_name as name, u.role
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
        [tokenHash]
      );
      return rows[0] ?? null;
    },

    async deleteSession(rawToken) {
      if (!rawToken) return;
      const tokenHash = hashToken(rawToken);
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    },

    async searchRooms({ checkIn, checkOut, guestCount }) {
      const query = `
        SELECT r.id, r.name, r.capacity, r.nightly_rate_cents as "nightlyRateCents",
               r.housekeeping_status as "housekeepingStatus", h.name as hotel
        FROM rooms r
        JOIN hotels h ON r.hotel_id = h.id
        WHERE r.capacity >= $1
          AND r.housekeeping_status = 'READY'
          AND NOT EXISTS (
            SELECT 1 FROM reservations res
            WHERE res.room_id = r.id
              AND res.status IN ('HELD', 'CONFIRMED')
              AND res.check_in < $3::date AND res.check_out > $2::date
          )
      `;
      const { rows } = await pool.query(query, [guestCount, checkIn, checkOut]);
      return rows;
    },

    async listAllRooms() {
      const query = `
        SELECT r.id, r.name, r.capacity, r.nightly_rate_cents as "nightlyRateCents",
               r.housekeeping_status as "housekeepingStatus", h.name as hotel
        FROM rooms r
        JOIN hotels h ON r.hotel_id = h.id
        ORDER BY r.name ASC
      `;
      const { rows } = await pool.query(query);
      return rows;
    },

    async createHold({ roomId, checkIn, checkOut, guestCount, userId = null }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const roomRes = await client.query(
          `SELECT r.id, r.name, r.capacity, r.nightly_rate_cents as "nightlyRateCents",
                  r.housekeeping_status as "housekeepingStatus", h.name as hotel
           FROM rooms r
           JOIN hotels h ON r.hotel_id = h.id
           WHERE r.id = $1 FOR UPDATE`,
          [roomId]
        );
        const room = roomRes.rows[0];
        if (!room) { await client.query("ROLLBACK"); return { kind: "room_not_found" }; }
        if (room.capacity < guestCount) { await client.query("ROLLBACK"); return { kind: "capacity_exceeded" }; }
        if (room.housekeepingStatus !== "READY") {
          await client.query("ROLLBACK");
          return { kind: "conflict", housekeepingStatus: room.housekeepingStatus };
        }

        const conflictRes = await client.query(
          `SELECT 1 FROM reservations
           WHERE room_id = $1
             AND status IN ('HELD', 'CONFIRMED')
             AND check_in < $3::date AND check_out > $2::date
           FOR UPDATE`,
          [roomId, checkIn, checkOut]
        );
        if (conflictRes.rowCount > 0) {
          await client.query("ROLLBACK");
          return { kind: "conflict", housekeepingStatus: room.housekeepingStatus };
        }

        const reservationId = crypto.randomUUID();
        const insertRes = await client.query(
          `INSERT INTO reservations (id, room_id, user_id, check_in, check_out, guest_count, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'HELD')
           RETURNING id, room_id as "roomId", user_id as "userId", check_in as "checkIn",
                     check_out as "checkOut", guest_count as "guestCount", status, created_at as "createdAt"`,
          [reservationId, roomId, userId, checkIn, checkOut, guestCount]
        );
        await client.query("COMMIT");
        return { kind: "created", reservation: insertRes.rows[0], room };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async confirmReservation(reservationId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resCheck = await client.query("SELECT * FROM reservations WHERE id = $1 FOR UPDATE", [reservationId]);
        const reservation = resCheck.rows[0];
        if (!reservation) { await client.query("ROLLBACK"); return { kind: "not_found" }; }
        if (reservation.status !== "HELD") { await client.query("ROLLBACK"); return { kind: "invalid_state" }; }

        await client.query("UPDATE reservations SET status = 'CONFIRMED' WHERE id = $1", [reservationId]);
        const paymentId = crypto.randomUUID();
        await client.query("INSERT INTO payment_attempts (id, reservation_id, status) VALUES ($1, $2, 'APPROVED')", [paymentId, reservationId]);

        const eventId = crypto.randomUUID();
        const payload = { reservationId, roomId: reservation.room_id, status: "CONFIRMED" };
        await client.query(
          "INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES ($1, 'booking.confirmation.requested', $2, $3)",
          [eventId, reservationId, JSON.stringify(payload)]
        );
        await client.query("COMMIT");
        return {
          kind: "confirmed",
          reservation: { ...reservation, status: "CONFIRMED" },
          payment: { id: paymentId, reservationId, status: "APPROVED" },
          event: { id: eventId, eventType: "booking.confirmation.requested" }
        };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async cancelReservation(reservationId, { userId = null, role = "guest" } = {}) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const resCheck = await client.query("SELECT * FROM reservations WHERE id = $1 FOR UPDATE", [reservationId]);
        const reservation = resCheck.rows[0];
        if (!reservation) { await client.query("ROLLBACK"); return { kind: "not_found" }; }
        if (role !== "staff" && reservation.user_id && reservation.user_id !== userId) {
          await client.query("ROLLBACK");
          return { kind: "forbidden" };
        }
        if (["CANCELLED", "CHECKED_IN", "CHECKED_OUT"].includes(reservation.status)) {
          await client.query("ROLLBACK");
          return { kind: "invalid_state", currentStatus: reservation.status };
        }

        await client.query("UPDATE reservations SET status = 'CANCELLED' WHERE id = $1", [reservationId]);
        const eventId = crypto.randomUUID();
        const payload = { reservationId, roomId: reservation.room_id, status: "CANCELLED" };
        await client.query(
          "INSERT INTO outbox_events (id, event_type, aggregate_id, payload) VALUES ($1, 'booking.cancelled', $2, $3)",
          [eventId, reservationId, JSON.stringify(payload)]
        );
        await client.query("COMMIT");
        return { kind: "cancelled", reservation: { ...reservation, status: "CANCELLED" } };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async listReservations({ userId = null, role = "staff" } = {}) {
      let query = `
        SELECT res.id, res.room_id as "roomId", res.user_id as "userId", res.check_in as "checkIn",
               res.check_out as "checkOut", res.guest_count as "guestCount", res.status, res.created_at as "createdAt",
               r.name as "roomName", h.name as "hotel"
        FROM reservations res
        JOIN rooms r ON res.room_id = r.id
        JOIN hotels h ON r.hotel_id = h.id
      `;
      const params = [];
      if (role !== "staff" && userId) {
        query += " WHERE res.user_id = $1";
        params.push(userId);
      }
      query += " ORDER BY res.created_at DESC";
      const { rows } = await pool.query(query, params);
      return rows.map((r) => ({
        id: r.id,
        roomId: r.roomId,
        userId: r.userId,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        guestCount: r.guestCount,
        status: r.status,
        createdAt: r.createdAt,
        room: { id: r.roomId, name: r.roomName, hotel: r.hotel }
      }));
    },

    async checkIn(reservationId) {
      const { rows } = await pool.query(
        "UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1 AND status = 'CONFIRMED' RETURNING *",
        [reservationId]
      );
      if (!rows.length) {
        const check = await pool.query("SELECT status FROM reservations WHERE id = $1", [reservationId]);
        if (!check.rows.length) return { kind: "not_found" };
        return { kind: "invalid_state" };
      }
      return { kind: "updated", reservation: rows[0] };
    },

    async updateHousekeeping(roomId, housekeepingStatus) {
      const { rows } = await pool.query(
        "UPDATE rooms SET housekeeping_status = $2 WHERE id = $1 RETURNING id, name, capacity, nightly_rate_cents as \"nightlyRateCents\", housekeeping_status as \"housekeepingStatus\"",
        [roomId, housekeepingStatus]
      );
      if (!rows.length) return { kind: "not_found" };
      return { kind: "updated", room: rows[0] };
    },

    async getOutboxEvents({ unpublishedOnly = true } = {}) {
      const query = unpublishedOnly
        ? "SELECT id, event_type as \"eventType\", aggregate_id as \"aggregateId\", payload, published_at as \"publishedAt\" FROM outbox_events WHERE published_at IS NULL ORDER BY created_at ASC"
        : "SELECT id, event_type as \"eventType\", aggregate_id as \"aggregateId\", payload, published_at as \"publishedAt\" FROM outbox_events ORDER BY created_at ASC";
      const { rows } = await pool.query(query);
      return rows;
    },

    async markOutboxPublished(eventId) {
      await pool.query("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP WHERE id = $1", [eventId]);
    }
  };
}

export function getStore(connectionString = process.env.DATABASE_URL) {
  return connectionString ? createPostgresStore(connectionString) : createStaySyncStore();
}

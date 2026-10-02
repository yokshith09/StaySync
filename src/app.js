import { getStore } from "./store.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

const error = (code, message, status) => json({ error: { code, message } }, status);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function extractToken(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

export function createStaySyncApp({
  store = getStore(),
  writeLog = () => {},
  environment = process.env.NODE_ENV ?? "development"
} = {}) {
  return {
    async fetch(request) {
      const startedAt = performance.now();
      const url = new URL(request.url);
      const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
      const rawToken = extractToken(request);
      const currentUser = await store.getUserByToken(rawToken);

      let response;
      let event = "request_completed";
      let severity = "INFO";
      let message = "Request completed";
      let component = "booking-api";

      if (request.method === "GET" && url.pathname === "/health") {
        response = json({
          status: "healthy",
          application: "staysync-booking-api",
          storage: process.env.DATABASE_URL ? "postgresql" : "in_memory"
        });
        component = "platform";
        message = "Health check completed";
      } else if (request.method === "POST" && url.pathname === "/api/auth/register") {
        component = "auth";
        let input;
        try { input = await request.json(); } catch { input = null; }
        if (!input?.name?.trim() || !input?.email?.trim() || !input?.password || input.password.length < 6) {
          response = error("VALIDATION_ERROR", "Name, valid email, and password of at least 6 characters are required", 422);
          event = "auth_register_invalid";
          severity = "WARNING";
          message = "Registration validation failed";
        } else {
          const result = await store.registerUser(input);
          if (result.kind === "email_exists") {
            response = error("EMAIL_EXISTS", "An account with this email address already exists", 409);
            event = "auth_register_duplicate";
            severity = "WARNING";
            message = "Registration rejected due to duplicate email";
          } else {
            response = json({ token: result.token, user: result.user }, 201, {
              "Set-Cookie": `session=${result.token}; HttpOnly; Path=/; SameSite=Lax`
            });
            event = "auth_register_success";
            severity = "INFO";
            message = "New guest registered and session established";
          }
        }
      } else if (request.method === "POST" && url.pathname === "/api/auth/login") {
        component = "auth";
        let input;
        try { input = await request.json(); } catch { input = null; }
        if (!input?.email || !input?.password) {
          response = error("VALIDATION_ERROR", "Email and password are required", 422);
          event = "auth_login_invalid";
          severity = "WARNING";
          message = "Missing login parameters";
        } else {
          const user = await store.authenticateUser(input);
          if (!user) {
            response = error("INVALID_CREDENTIALS", "Invalid email or password", 401);
            event = "auth_login_failed";
            severity = "WARNING";
            message = "Login attempt failed";
          } else {
            const session = await store.createSession(user.id);
            response = json({ token: session.token, user: session.user }, 200, {
              "Set-Cookie": `session=${session.token}; HttpOnly; Path=/; SameSite=Lax`
            });
            event = "auth_login_success";
            severity = "INFO";
            message = `User logged in with role: ${session.user.role}`;
          }
        }
      } else if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        component = "auth";
        if (rawToken) await store.deleteSession(rawToken);
        response = json({ success: true }, 200, {
          "Set-Cookie": "session=; HttpOnly; Path=/; Max-Age=0"
        });
        event = "auth_logout";
        severity = "INFO";
        message = "User session terminated";
      } else if (request.method === "GET" && url.pathname === "/api/auth/me") {
        component = "auth";
        if (!currentUser) {
          response = error("UNAUTHORIZED", "Not signed in", 401);
          event = "auth_unauthenticated";
          severity = "INFO";
          message = "No active session";
        } else {
          response = json({ user: currentUser });
          event = "auth_profile_viewed";
          severity = "INFO";
          message = "Session validated";
        }
      } else if (request.method === "GET" && url.pathname === "/api/rooms") {
        const checkIn = url.searchParams.get("checkIn");
        const checkOut = url.searchParams.get("checkOut");
        const guestCount = Number(url.searchParams.get("guests"));

        if (request.headers.get("x-demo-scenario") === "database_timeout") {
          response = error("DATABASE_TIMEOUT", "Availability service could not reach its database", 503);
          event = "database_timeout";
          severity = "ERROR";
          message = "Simulated database timeout while searching rooms";
        } else if (!validDate(checkIn) || !validDate(checkOut) || checkIn >= checkOut || !Number.isInteger(guestCount) || guestCount < 1) {
          response = error("VALIDATION_ERROR", "checkIn, checkOut, and a positive guests value are required", 422);
          event = "room_search_invalid";
          severity = "WARNING";
          message = "Invalid room search";
        } else {
          const rooms = await store.searchRooms({ checkIn, checkOut, guestCount });
          response = json({ rooms });
          event = "room_search_completed";
          message = "Room search completed";
        }
      } else if (request.method === "GET" && url.pathname === "/api/rooms/all") {
        component = "operations";
        if (!currentUser || currentUser.role !== "staff") {
          response = error("FORBIDDEN", "Staff credentials required to view full room inventory", 403);
          event = "auth_unauthorized_access";
          severity = "WARNING";
          message = "Unauthorized room inventory query";
        } else {
          const rooms = await store.listAllRooms();
          response = json({ rooms });
          event = "rooms_catalog_listed";
          message = "Room inventory retrieved";
        }
      } else if (request.method === "POST" && url.pathname === "/api/reservations") {
        let input;
        try { input = await request.json(); } catch { input = null; }

        if (!input || !input.roomId || !validDate(input.checkIn) || !validDate(input.checkOut) || input.checkIn >= input.checkOut || !Number.isInteger(input.guestCount) || input.guestCount < 1) {
          response = error("VALIDATION_ERROR", "roomId, valid dates, and a positive guestCount are required", 422);
          event = "reservation_invalid";
          severity = "WARNING";
          message = "Invalid reservation request";
        } else {
          const result = await store.createHold({ ...input, userId: currentUser?.id ?? null });
          if (result.kind === "room_not_found") {
            response = error("ROOM_NOT_FOUND", "The selected room does not exist", 404);
            event = "reservation_room_missing";
            severity = "WARNING";
            message = "Reservation referenced a missing room";
          } else if (result.kind === "capacity_exceeded") {
            response = error("ROOM_CAPACITY_EXCEEDED", "The selected room cannot accommodate this guest count", 409);
            event = "reservation_capacity_conflict";
            severity = "WARNING";
            message = "Room capacity exceeded";
          } else if (result.kind === "conflict") {
            const isCleaning = result.housekeepingStatus === "CLEANING";
            response = error(
              isCleaning ? "ROOM_UNDER_CLEANING" : "RESERVATION_CONFLICT",
              isCleaning ? "This room is currently being serviced by housekeeping" : "This room is no longer available for the selected dates",
              409
            );
            event = isCleaning ? "room_unavailable_cleaning" : "reservation_conflict";
            severity = "WARNING";
            message = isCleaning ? "Booking prevented due to active cleaning" : "Overlapping reservation was prevented";
          } else {
            response = json({ reservation: result.reservation, room: result.room }, 201);
            event = "reservation_held";
            message = "Reservation hold created";
          }
        }
      } else if (request.method === "POST" && url.pathname === "/api/payments") {
        let input;
        try { input = await request.json(); } catch { input = null; }

        if (!input?.reservationId) {
          response = error("VALIDATION_ERROR", "reservationId is required", 422);
          event = "payment_invalid";
          severity = "WARNING";
          message = "Invalid payment request";
        } else if (request.headers.get("x-demo-scenario") === "payment_failure") {
          response = error("PAYMENT_PROVIDER_REJECTED", "The simulated payment provider rejected this booking", 502);
          event = "payment_provider_rejected";
          severity = "ERROR";
          message = "Simulated provider rejected payment";
        } else {
          const slowPayment = request.headers.get("x-demo-scenario") === "slow_payment";
          if (slowPayment) await new Promise((resolve) => setTimeout(resolve, 125));

          const result = await store.confirmReservation(input.reservationId);
          if (result.kind === "not_found") {
            response = error("RESERVATION_NOT_FOUND", "The reservation does not exist", 404);
            event = "payment_reservation_missing";
            severity = "WARNING";
            message = "Payment referenced missing reservation";
          } else if (result.kind === "invalid_state") {
            response = error("RESERVATION_NOT_PAYABLE", "Only held reservations can be paid", 409);
            event = "payment_invalid_state";
            severity = "WARNING";
            message = "Payment attempted for invalid reservation state";
          } else {
            response = json({ payment: result.payment, reservation: result.reservation }, 201);
            event = slowPayment ? "payment_slow" : "confirmation_requested";
            severity = slowPayment ? "WARNING" : "INFO";
            message = slowPayment ? "Payment completed above demo latency threshold" : "Booking confirmation event requested";
          }
        }
      } else if (request.method === "POST" && /^\/api\/reservations\/[^/]+\/cancel$/.test(url.pathname)) {
        const reservationId = url.pathname.split("/")[3];
        const result = await store.cancelReservation(reservationId, {
          userId: currentUser?.id ?? null,
          role: currentUser?.role ?? "guest"
        });

        if (result.kind === "not_found") {
          response = error("RESERVATION_NOT_FOUND", "The reservation does not exist", 404);
          event = "cancel_reservation_missing";
          severity = "WARNING";
          message = "Cancellation referenced missing reservation";
        } else if (result.kind === "forbidden") {
          response = error("FORBIDDEN", "You do not have permission to cancel this reservation", 403);
          event = "auth_unauthorized_access";
          severity = "WARNING";
          message = "Unauthorized cancellation attempt";
        } else if (result.kind === "invalid_state") {
          response = error("RESERVATION_NOT_CANCELLABLE", `Reservation in status ${result.currentStatus} cannot be cancelled`, 409);
          event = "cancel_invalid_state";
          severity = "WARNING";
          message = "Cancellation attempted in terminal or checked-in state";
        } else {
          response = json({ reservation: result.reservation }, 200);
          event = "reservation_cancelled";
          severity = "INFO";
          message = "Reservation successfully cancelled and room released";
        }
      } else if (request.method === "GET" && url.pathname === "/api/reservations") {
        component = "operations";
        const forceUnauthorized = request.headers.get("x-demo-scenario") === "unauthorized_desk";
        if (forceUnauthorized || (!currentUser || currentUser.role !== "staff")) {
          response = error("FORBIDDEN", "Staff credentials required to access hotel reservations desk", 403);
          event = "auth_unauthorized_access";
          severity = "WARNING";
          message = "Unauthorized attempt to access hotel desk";
        } else {
          const reservations = await store.listReservations({ role: "staff" });
          response = json({ reservations });
          event = "reservation_listed";
          message = "Reservations retrieved";
        }
      } else if (request.method === "GET" && url.pathname === "/api/reservations/my") {
        component = "guest";
        if (!currentUser) {
          response = error("UNAUTHORIZED", "Sign in required to view your stays", 401);
          event = "auth_unauthenticated";
          severity = "INFO";
          message = "Guest stay query without session";
        } else {
          const reservations = await store.listReservations({ userId: currentUser.id, role: currentUser.role });
          response = json({ reservations });
          event = "guest_stays_retrieved";
          message = "Guest stays retrieved";
        }
      } else if (request.method === "PATCH" && /^\/api\/reservations\/[^/]+\/check-in$/.test(url.pathname)) {
        component = "operations";
        if (!currentUser || currentUser.role !== "staff") {
          response = error("FORBIDDEN", "Staff credentials required to check in guests", 403);
          event = "auth_unauthorized_access";
          severity = "WARNING";
          message = "Unauthorized check-in attempt";
        } else {
          const reservationId = url.pathname.split("/")[3];
          const result = await store.checkIn(reservationId);
          if (result.kind === "not_found") {
            response = error("RESERVATION_NOT_FOUND", "The reservation does not exist", 404);
            event = "check_in_missing";
            severity = "WARNING";
            message = "Check-in referenced missing reservation";
          } else if (result.kind === "invalid_state") {
            response = error("RESERVATION_NOT_CHECK_IN_READY", "Only confirmed reservations can be checked in", 409);
            event = "check_in_invalid_state";
            severity = "WARNING";
            message = "Check-in attempted in invalid state";
          } else {
            response = json({ reservation: result.reservation });
            event = "guest_checked_in";
            message = "Guest checked in";
          }
        }
      } else if (request.method === "PATCH" && /^\/api\/rooms\/[^/]+\/housekeeping$/.test(url.pathname)) {
        component = "operations";
        if (!currentUser || currentUser.role !== "staff") {
          response = error("FORBIDDEN", "Staff credentials required to update room housekeeping", 403);
          event = "auth_unauthorized_access";
          severity = "WARNING";
          message = "Unauthorized housekeeping update attempt";
        } else {
          const roomId = url.pathname.split("/")[3];
          let input;
          try { input = await request.json(); } catch { input = null; }
          const result =
            input?.housekeepingStatus === "READY" || input?.housekeepingStatus === "CLEANING"
              ? await store.updateHousekeeping(roomId, input.housekeepingStatus)
              : { kind: "invalid" };

          if (result.kind === "not_found") {
            response = error("ROOM_NOT_FOUND", "The room does not exist", 404);
            event = "housekeeping_room_missing";
            severity = "WARNING";
            message = "Housekeeping referenced missing room";
          } else if (result.kind === "invalid") {
            response = error("VALIDATION_ERROR", "housekeepingStatus must be READY or CLEANING", 422);
            event = "housekeeping_invalid";
            severity = "WARNING";
            message = "Invalid housekeeping update";
          } else {
            response = json({ room: result.room });
            event = "housekeeping_updated";
            message = "Housekeeping status updated";
          }
        }
      } else {
        response = error("NOT_FOUND", "Route not found", 404);
        event = "route_not_found";
        severity = "WARNING";
        component = "platform";
        message = "Route not found";
      }

      writeLog({
        timestamp: new Date().toISOString(),
        severity,
        event,
        component,
        entryPoint: "http",
        requestId,
        route: url.pathname,
        statusCode: response.status,
        responseTimeMs: Math.round(performance.now() - startedAt),
        environment,
        message
      });

      return response;
    }
  };
}

import { createStaySyncStore } from "./store.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const error = (code, message, status) => json({ error: { code, message } }, status);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export function createStaySyncApp({ store = createStaySyncStore(), writeLog = () => {}, environment = process.env.NODE_ENV ?? "development" } = {}) {
  return {
    async fetch(request) {
      const startedAt = performance.now();
      const url = new URL(request.url);
      const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
      let response; let event = "request_completed"; let severity = "INFO"; let message = "Request completed"; let component = "booking-api";

      if (request.method === "GET" && url.pathname === "/health") {
        response = json({ status: "healthy", application: "staysync-booking-api", storage: "in_memory" });
        component = "platform"; message = "Health check completed";
      } else if (request.method === "GET" && url.pathname === "/api/rooms") {
        const checkIn = url.searchParams.get("checkIn"); const checkOut = url.searchParams.get("checkOut"); const guestCount = Number(url.searchParams.get("guests"));
        if (!validDate(checkIn) || !validDate(checkOut) || checkIn >= checkOut || !Number.isInteger(guestCount) || guestCount < 1) {
          response = error("VALIDATION_ERROR", "checkIn, checkOut, and a positive guests value are required", 422); event = "room_search_invalid"; severity = "WARNING"; message = "Invalid room search";
        } else { response = json({ rooms: store.searchRooms({ checkIn, checkOut, guestCount }) }); event = "room_search_completed"; message = "Room search completed"; }
      } else if (request.method === "POST" && url.pathname === "/api/reservations") {
        let input; try { input = await request.json(); } catch { input = null; }
        if (!input || !input.roomId || !validDate(input.checkIn) || !validDate(input.checkOut) || input.checkIn >= input.checkOut || !Number.isInteger(input.guestCount) || input.guestCount < 1) {
          response = error("VALIDATION_ERROR", "roomId, valid dates, and a positive guestCount are required", 422); event = "reservation_invalid"; severity = "WARNING"; message = "Invalid reservation request";
        } else {
          const result = store.createHold(input);
          if (result.kind === "room_not_found") { response = error("ROOM_NOT_FOUND", "The selected room does not exist", 404); event = "reservation_room_missing"; severity = "WARNING"; message = "Reservation referenced a missing room"; }
          else if (result.kind === "capacity_exceeded") { response = error("ROOM_CAPACITY_EXCEEDED", "The selected room cannot accommodate this guest count", 409); event = "reservation_capacity_conflict"; severity = "WARNING"; message = "Room capacity exceeded"; }
          else if (result.kind === "conflict") { response = error("RESERVATION_CONFLICT", "This room is no longer available for the selected dates", 409); event = "reservation_conflict"; severity = "WARNING"; message = "Overlapping reservation was prevented"; }
          else { response = json({ reservation: result.reservation, room: result.room }, 201); event = "reservation_held"; message = "Reservation hold created"; }
        }
      } else if (request.method === "POST" && url.pathname === "/api/payments") {
        let input; try { input = await request.json(); } catch { input = null; }
        if (!input?.reservationId) {
          response = error("VALIDATION_ERROR", "reservationId is required", 422); event = "payment_invalid"; severity = "WARNING"; message = "Invalid payment request";
        } else if (request.headers.get("x-demo-scenario") === "payment_failure") {
          response = error("PAYMENT_PROVIDER_REJECTED", "The simulated payment provider rejected this booking", 502); event = "payment_provider_rejected"; severity = "ERROR"; message = "Simulated provider rejected payment";
        } else {
          const result = store.confirmReservation(input.reservationId);
          if (result.kind === "not_found") { response = error("RESERVATION_NOT_FOUND", "The reservation does not exist", 404); event = "payment_reservation_missing"; severity = "WARNING"; message = "Payment referenced missing reservation"; }
          else if (result.kind === "invalid_state") { response = error("RESERVATION_NOT_PAYABLE", "Only held reservations can be paid", 409); event = "payment_invalid_state"; severity = "WARNING"; message = "Payment attempted for invalid reservation state"; }
          else { response = json({ payment: result.payment, reservation: result.reservation }, 201); event = "confirmation_requested"; message = "Booking confirmation event requested"; }
        }
      } else if (request.method === "GET" && url.pathname === "/api/reservations") {
        response = json({ reservations: store.listReservations() }); component = "operations"; event = "reservation_listed"; message = "Reservations retrieved";
      } else if (request.method === "PATCH" && /^\/api\/reservations\/[^/]+\/check-in$/.test(url.pathname)) {
        const reservationId = url.pathname.split("/")[3]; const result = store.checkIn(reservationId); component = "operations";
        if (result.kind === "not_found") { response = error("RESERVATION_NOT_FOUND", "The reservation does not exist", 404); event = "check_in_missing"; severity = "WARNING"; message = "Check-in referenced missing reservation"; }
        else if (result.kind === "invalid_state") { response = error("RESERVATION_NOT_CHECK_IN_READY", "Only confirmed reservations can be checked in", 409); event = "check_in_invalid_state"; severity = "WARNING"; message = "Check-in attempted in invalid state"; }
        else { response = json({ reservation: result.reservation }); event = "guest_checked_in"; message = "Guest checked in"; }
      } else if (request.method === "PATCH" && /^\/api\/rooms\/[^/]+\/housekeeping$/.test(url.pathname)) {
        const roomId = url.pathname.split("/")[3]; let input; try { input = await request.json(); } catch { input = null; } const result = input?.housekeepingStatus === "READY" || input?.housekeepingStatus === "CLEANING" ? store.updateHousekeeping(roomId, input.housekeepingStatus) : { kind: "invalid" }; component = "operations";
        if (result.kind === "not_found") { response = error("ROOM_NOT_FOUND", "The room does not exist", 404); event = "housekeeping_room_missing"; severity = "WARNING"; message = "Housekeeping referenced missing room"; }
        else if (result.kind === "invalid") { response = error("VALIDATION_ERROR", "housekeepingStatus must be READY or CLEANING", 422); event = "housekeeping_invalid"; severity = "WARNING"; message = "Invalid housekeeping update"; }
        else { response = json({ room: result.room }); event = "housekeeping_updated"; message = "Housekeeping status updated"; }
      } else { response = error("NOT_FOUND", "Route not found", 404); event = "route_not_found"; severity = "WARNING"; component = "platform"; message = "Route not found"; }

      writeLog({ timestamp: new Date().toISOString(), severity, event, component, entryPoint: "http", requestId, route: url.pathname, statusCode: response.status, responseTimeMs: Math.round(performance.now() - startedAt), environment, message });
      return response;
    }
  };
}

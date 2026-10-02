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

  return {
    searchRooms({ checkIn, checkOut, guestCount }) {
      return [...rooms.values()].filter((room) => room.capacity >= guestCount && room.housekeepingStatus === "READY" && ![...reservations.values()].some((reservation) => reservation.roomId === room.id && ["HELD", "CONFIRMED"].includes(reservation.status) && overlaps(checkIn, checkOut, reservation.checkIn, reservation.checkOut))).map((room) => ({ ...room }));
    },
    createHold({ roomId, checkIn, checkOut, guestCount }) {
      const room = rooms.get(roomId);
      if (!room) return { kind: "room_not_found" };
      if (room.capacity < guestCount) return { kind: "capacity_exceeded" };
      if (room.housekeepingStatus !== "READY" || [...reservations.values()].some((reservation) => reservation.roomId === roomId && ["HELD", "CONFIRMED"].includes(reservation.status) && overlaps(checkIn, checkOut, reservation.checkIn, reservation.checkOut))) return { kind: "conflict" };
      const reservation = { id: crypto.randomUUID(), roomId, checkIn, checkOut, guestCount, status: "HELD", createdAt: new Date().toISOString() };
      reservations.set(reservation.id, reservation);
      return { kind: "created", reservation: { ...reservation }, room: { ...room } };
    },
    confirmReservation(reservationId) {
      const reservation = reservations.get(reservationId);
      if (!reservation) return { kind: "not_found" };
      if (reservation.status !== "HELD") return { kind: "invalid_state" };
      reservation.status = "CONFIRMED";
      return { kind: "confirmed", reservation: { ...reservation }, payment: { id: crypto.randomUUID(), reservationId, status: "APPROVED" } };
    },
    listReservations() { return [...reservations.values()].map((reservation) => ({ ...reservation, room: { ...rooms.get(reservation.roomId) } })); },
    checkIn(reservationId) {
      const reservation = reservations.get(reservationId);
      if (!reservation) return { kind: "not_found" };
      if (reservation.status !== "CONFIRMED") return { kind: "invalid_state" };
      reservation.status = "CHECKED_IN"; return { kind: "updated", reservation: { ...reservation } };
    },
    updateHousekeeping(roomId, housekeepingStatus) {
      const room = rooms.get(roomId);
      if (!room) return { kind: "not_found" };
      room.housekeepingStatus = housekeepingStatus; return { kind: "updated", room: { ...room } };
    }
  };
}

const form = document.querySelector("#search");
const rooms = document.querySelector("#rooms");
const status = document.querySelector("#status");
const journey = document.querySelector("#journey");
const deskLock = document.querySelector("#desk-lock");
const deskContent = document.querySelector("#desk-content");
const roomInventory = document.querySelector("#room-inventory");
const operationsList = document.querySelector("#operations-list");
const guestReservation = document.querySelector("#guest-reservation");
const scenarioResult = document.querySelector("#scenario-result");
const userBadge = document.querySelector("#user-badge");
const openAuthBtn = document.querySelector("#open-auth-btn");
const signOutBtn = document.querySelector("#sign-out-btn");
const quickStaffLogin = document.querySelector("#quick-staff-login");

// Modal Elements
const authDialog = document.querySelector("#auth-dialog");
const authTitle = document.querySelector("#auth-title");
const closeAuthBtn = document.querySelector("#close-auth-btn");
const tabLogin = document.querySelector("#tab-login");
const tabRegister = document.querySelector("#tab-register");
const loginForm = document.querySelector("#login-form");
const registerForm = document.querySelector("#register-form");
const authError = document.querySelector("#auth-error");
const quickPickStaff = document.querySelector("#quick-pick-staff");
const quickPickGuest = document.querySelector("#quick-pick-guest");

const receiptDialog = document.querySelector("#receipt-dialog");
const receiptContent = document.querySelector("#receipt-content");
const closeReceiptBtn = document.querySelector("#close-receipt-btn");
const dismissReceiptBtn = document.querySelector("#dismiss-receipt-btn");

let activeReservationId = null;
let currentReservationData = null;
let currentToken = localStorage.getItem("staysync_token") || null;
let currentUser = null;

const money = (cents) => `$${(cents / 100).toFixed(0)}`;
const dates = () => Object.fromEntries(new FormData(form));
const setStatus = (text, tone = "") => { status.textContent = text; status.className = `status ${tone}`; };

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (currentToken && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${currentToken}`;
  }
  const response = await fetch(path, { ...options, headers });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function updateAuthUI() {
  if (currentUser) {
    userBadge.textContent = `${currentUser.name} (${currentUser.role})`;
    userBadge.className = `user-badge ${currentUser.role}`;
    openAuthBtn.hidden = true;
    signOutBtn.hidden = false;

    if (currentUser.role === "staff") {
      deskLock.hidden = true;
      deskContent.hidden = false;
    } else {
      deskLock.hidden = false;
      deskContent.hidden = true;
    }
  } else {
    userBadge.textContent = "Guest mode";
    userBadge.className = "user-badge";
    openAuthBtn.hidden = false;
    signOutBtn.hidden = true;
    deskLock.hidden = false;
    deskContent.hidden = true;
  }
}

async function checkSession() {
  if (!currentToken) return updateAuthUI();
  const { response, body } = await request("/api/auth/me");
  if (response.ok && body.user) {
    currentUser = body.user;
  } else {
    currentToken = null;
    currentUser = null;
    localStorage.removeItem("staysync_token");
  }
  updateAuthUI();
  if (currentUser?.role === "staff") await loadDesk();
  await loadMyStays();
}

async function loginUser(email, password) {
  authError.hidden = true;
  const { response, body } = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (response.ok) {
    currentToken = body.token;
    currentUser = body.user;
    localStorage.setItem("staysync_token", currentToken);
    updateAuthUI();
    authDialog.close();
    setStatus(`Welcome back, ${currentUser.name}.`, "success");
    if (currentUser.role === "staff") await loadDesk();
    await loadMyStays();
  } else {
    authError.textContent = body?.error?.message || "Invalid email or password.";
    authError.hidden = false;
  }
}

async function registerUser(name, email, password) {
  authError.hidden = true;
  const { response, body } = await request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password })
  });
  if (response.ok) {
    currentToken = body.token;
    currentUser = body.user;
    localStorage.setItem("staysync_token", currentToken);
    updateAuthUI();
    authDialog.close();
    setStatus(`Account created. Welcome, ${currentUser.name}!`, "success");
    await loadMyStays();
  } else {
    authError.textContent = body?.error?.message || "Registration failed.";
    authError.hidden = false;
  }
}

async function logout() {
  await request("/api/auth/logout", { method: "POST" });
  currentToken = null;
  currentUser = null;
  localStorage.removeItem("staysync_token");
  updateAuthUI();
  setStatus("Signed out.", "info");
}

// Modal Listeners
openAuthBtn?.addEventListener("click", () => {
  authError.hidden = true;
  authDialog.showModal();
});

closeAuthBtn?.addEventListener("click", () => authDialog.close());
signOutBtn?.addEventListener("click", logout);

tabLogin?.addEventListener("click", () => {
  tabLogin.classList.add("active");
  tabRegister.classList.remove("active");
  loginForm.hidden = false;
  registerForm.hidden = true;
  authError.hidden = true;
});

tabRegister?.addEventListener("click", () => {
  tabRegister.classList.add("active");
  tabLogin.classList.remove("active");
  registerForm.hidden = false;
  loginForm.hidden = true;
  authError.hidden = true;
});

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(loginForm));
  await loginUser(data.email, data.password);
});

registerForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(registerForm));
  await registerUser(data.name, data.email, data.password);
});

quickPickStaff?.addEventListener("click", () => {
  loginForm.elements.email.value = "staff@staysync.internal";
  loginForm.elements.password.value = "DeskPass2026!";
});

quickPickGuest?.addEventListener("click", () => {
  loginForm.elements.email.value = "guest@staysync.internal";
  loginForm.elements.password.value = "GuestPass2026!";
});

quickStaffLogin?.addEventListener("click", () => loginUser("staff@staysync.internal", "DeskPass2026!"));

closeReceiptBtn?.addEventListener("click", () => receiptDialog.close());
dismissReceiptBtn?.addEventListener("click", () => receiptDialog.close());

function showReceipt(reservation, room) {
  const checkIn = new Date(reservation.checkIn);
  const checkOut = new Date(reservation.checkOut);
  const nights = Math.max(1, Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24)));
  const rate = room.nightlyRateCents || 18400;
  const total = nights * rate;

  receiptContent.innerHTML = `
    <div class="receipt-header">
      <h4>${room.hotel || "Harbor House"}</h4>
      <p class="receipt-ref">FOLIO #${reservation.id.slice(0, 8).toUpperCase()}</p>
    </div>
    <div class="receipt-details">
      <div><strong>Guest</strong><p>${currentUser ? currentUser.name : "Guest Traveler"}</p></div>
      <div><strong>Status</strong><p class="state">${reservation.status.replace("_", " ")}</p></div>
      <div><strong>Dates</strong><p>${reservation.checkIn} → ${reservation.checkOut} (${nights} night${nights > 1 ? "s" : ""})</p></div>
      <div><strong>Room</strong><p>${room.name} · Sleeps ${reservation.guestCount}</p></div>
    </div>
    <div class="receipt-charges">
      <div class="charge-row"><span>${nights} night(s) @ ${money(rate)}/night</span><strong>${money(total)}</strong></div>
      <div class="charge-row"><span>Occupancy & city fees</span><strong>$0 (Demo waiver)</strong></div>
      <div class="charge-total"><span>Total Paid</span><strong>${money(total)}</strong></div>
    </div>
  `;
  receiptDialog.showModal();
}

function renderGuestReservation(reservation, room) {
  currentReservationData = { reservation, room };
  const isCancellable = !["CANCELLED", "CHECKED_IN", "CHECKED_OUT"].includes(reservation.status);

  guestReservation.innerHTML = `
    <article class="reservation-summary">
      <div class="summary-top">
        <p class="room-meta">${room.hotel || "Harbor House"} · ${room.name}</p>
        <span class="state ${reservation.status.toLowerCase()}">${reservation.status.replace("_", " ")}</span>
      </div>
      <h3>${reservation.checkIn} → ${reservation.checkOut}</h3>
      <p>${reservation.guestCount} guests · BOOKING REFERENCE: <strong>${reservation.id.slice(0, 8).toUpperCase()}</strong></p>
      <div class="reservation-buttons">
        <button type="button" class="quiet-button view-receipt-btn" data-id="${reservation.id}">View Guest Folio</button>
        ${isCancellable ? `<button type="button" class="cancel-booking-btn" data-id="${reservation.id}">Cancel Reservation</button>` : ""}
      </div>
    </article>
  `;
}

guestReservation?.addEventListener("click", async (e) => {
  if (e.target.classList.contains("view-receipt-btn") && currentReservationData) {
    showReceipt(currentReservationData.reservation, currentReservationData.room);
  } else if (e.target.classList.contains("cancel-booking-btn")) {
    const id = e.target.dataset.id;
    if (!confirm("Are you sure you wish to cancel this reservation?")) return;
    const { response, body } = await request(`/api/reservations/${id}/cancel`, { method: "POST" });
    if (response.ok) {
      setStatus("Reservation cancelled. Room availability released.", "success");
      currentReservationData.reservation.status = "CANCELLED";
      renderGuestReservation(currentReservationData.reservation, currentReservationData.room);
      if (currentUser?.role === "staff") await loadDesk();
    } else {
      setStatus(body?.error?.message || "Failed to cancel reservation", "error");
    }
  }
});

async function loadMyStays() {
  if (!currentUser) return;
  const { response, body } = await request("/api/reservations/my");
  if (response.ok && body.reservations?.length > 0) {
    const latest = body.reservations[0];
    renderGuestReservation(latest, latest.room);
  }
}

function showJourney(reservation, room) {
  activeReservationId = reservation.id;
  currentReservationData = { reservation, room };
  journey.hidden = false;
  renderGuestReservation(reservation, room);
  journey.innerHTML = `
    <div>
      <p class="kicker">Reservation held</p>
      <h2>${room.name} is waiting for you.</h2>
      <p>${reservation.checkIn} → ${reservation.checkOut} · ${reservation.guestCount} guests</p>
      <p class="reference">REFERENCE ${reservation.id.slice(0, 8).toUpperCase()}</p>
    </div>
    <div class="payment-actions">
      <label>Demo payment outcome
        <select id="payment-scenario">
          <option value="approved">Approved</option>
          <option value="payment_failure">Provider rejects payment (502)</option>
          <option value="slow_payment">Slow provider response (latency)</option>
        </select>
      </label>
      <button id="pay" data-reservation="${reservation.id}">Continue to payment</button>
    </div>
  `;
  journey.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  rooms.innerHTML = "";
  journey.hidden = true;
  setStatus("Looking for rooms that fit your stay…");
  const { response, body } = await request(`/api/rooms?${new URLSearchParams(dates())}`);
  if (!response.ok) return setStatus(body?.error?.message || "Search failed", "error");
  setStatus(body.rooms.length ? `${body.rooms.length} rooms are ready for your dates.` : "No rooms are available for these dates.");
  rooms.innerHTML = body.rooms.map((room, index) => `
    <article class="room-card" style="--delay:${index * 80}ms">
      <p class="room-meta">${room.hotel} / <span class="state ${room.housekeepingStatus.toLowerCase()}">${room.housekeepingStatus}</span></p>
      <h3>${room.name}</h3>
      <p>Sleeps ${room.capacity}. A calm base for the coast and city alike.</p>
      <div class="room-bottom">
        <strong>${money(room.nightlyRateCents)} <small>per night</small></strong>
        <button data-room="${room.id}" ${room.housekeepingStatus !== "READY" ? "disabled" : ""}>
          ${room.housekeepingStatus === "READY" ? "Hold room" : "Under Service"}
        </button>
      </div>
    </article>
  `).join("");
});

rooms?.addEventListener("click", async (event) => {
  const roomId = event.target.dataset.room;
  if (!roomId) return;
  const values = dates();
  const { response, body } = await request("/api/reservations", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ roomId, checkIn: values.checkIn, checkOut: values.checkOut, guestCount: Number(values.guests) })
  });
  if (!response.ok) return setStatus(body?.error?.message || "Reservation failed", "error");
  setStatus("Your room is held for the next step.", "success");
  showJourney(body.reservation, body.room);
});

journey?.addEventListener("click", async (event) => {
  const reservationId = event.target.dataset.reservation;
  if (!reservationId) return;
  event.target.disabled = true;
  event.target.textContent = "Confirming…";
  const scenario = document.querySelector("#payment-scenario")?.value;
  const headers = { "content-type": "application/json" };
  if (scenario !== "approved") headers["x-demo-scenario"] = scenario;

  const { response, body } = await request("/api/payments", {
    method: "POST",
    headers,
    body: JSON.stringify({ reservationId })
  });

  if (!response.ok) {
    event.target.disabled = false;
    event.target.textContent = "Try payment again";
    journey.querySelector(".payment-actions").insertAdjacentHTML(
      "beforeend",
      `<p class="payment-error">Demo provider declined this payment. Emits an ERROR log in Cloud Logging after deployment.</p>`
    );
    return setStatus(body?.error?.message || "Payment declined", "error");
  }

  journey.innerHTML = `
    <div>
      <p class="kicker">Reservation confirmed</p>
      <h2>Your StaySync booking is complete.</h2>
      <p>A confirmation event has been written to the database outbox. In the deployed demo, Pub/Sub delivers this to the confirmation worker.</p>
      <p class="reference">CONFIRMED ${body.reservation.id.slice(0, 8).toUpperCase()}</p>
    </div>
    <div class="confirmed-actions">
      <button type="button" id="journey-receipt-btn" class="button-link">View Folio Receipt</button>
      <a class="button-link secondary" href="#operations">Open hotel desk</a>
    </div>
  `;
  document.querySelector("#journey-receipt-btn")?.addEventListener("click", () => {
    showReceipt(body.reservation, currentReservationData.room);
  });

  setStatus(scenario === "slow_payment" ? "Payment was approved after simulated slow response." : "Payment approved and confirmation event queued.", "success");
  renderGuestReservation(body.reservation, currentReservationData.room);
  if (currentUser?.role === "staff") await loadDesk();
});

async function loadDesk() {
  if (!currentUser || currentUser.role !== "staff") return;

  // 1. Load Room Inventory & Housekeeping
  const roomRes = await request("/api/rooms/all");
  if (roomRes.response.ok) {
    roomInventory.innerHTML = roomRes.body.rooms.map((r) => `
      <div class="inventory-card">
        <div>
          <strong>${r.name}</strong> <span class="room-hotel">${r.hotel}</span>
          <p class="status-indicator ${r.housekeepingStatus.toLowerCase()}">${r.housekeepingStatus}</p>
        </div>
        <div class="inventory-controls">
          <button type="button" class="mini-btn ${r.housekeepingStatus === 'READY' ? 'active' : ''}" data-room="${r.id}" data-action="READY">Ready</button>
          <button type="button" class="mini-btn ${r.housekeepingStatus === 'CLEANING' ? 'active' : ''}" data-room="${r.id}" data-action="CLEANING">Cleaning</button>
        </div>
      </div>
    `).join("");
  }

  // 2. Load Reservations
  const res = await request("/api/reservations");
  if (!res.response.ok) {
    operationsList.innerHTML = `<p class="empty">${res.body?.error?.message || "Could not retrieve reservations"}</p>`;
    return;
  }
  operationsList.innerHTML = res.body.reservations.length ? res.body.reservations.map((reservation) => `
    <article class="reservation-row">
      <div>
        <p class="room-meta">${reservation.room.hotel} · ${reservation.room.name}</p>
        <h3>${reservation.checkIn} → ${reservation.checkOut}</h3>
        <p>${reservation.guestCount} guests · <span class="state ${reservation.status.toLowerCase()}">${reservation.status.replace("_", " ")}</span></p>
      </div>
      <div class="row-actions">
        ${reservation.status === "CONFIRMED" ? `<button data-checkin="${reservation.id}">Check in guest</button>` : ""}
        ${!["CANCELLED", "CHECKED_IN", "CHECKED_OUT"].includes(reservation.status) ? `<button class="quiet-button cancel-row-btn" data-cancel="${reservation.id}">Cancel</button>` : ""}
      </div>
    </article>
  `).join("") : `<p class="empty">No reservations yet. Complete a guest booking above to populate the desk.</p>`;
}

document.querySelector("#refresh-ops")?.addEventListener("click", loadDesk);
document.querySelector("#refresh-stay")?.addEventListener("click", loadMyStays);

roomInventory?.addEventListener("click", async (e) => {
  const roomId = e.target.dataset.room;
  const status = e.target.dataset.action;
  if (!roomId || !status) return;

  const { response, body } = await request(`/api/rooms/${roomId}/housekeeping`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ housekeepingStatus: status })
  });

  if (response.ok) {
    setStatus(`Room ${roomId} housekeeping updated to ${status}.`, "success");
    await loadDesk();
  } else {
    setStatus(body?.error?.message || "Failed to update room", "error");
  }
});

operationsList?.addEventListener("click", async (event) => {
  const checkInId = event.target.dataset.checkin;
  const cancelId = event.target.dataset.cancel;

  if (checkInId) {
    const { response, body } = await request(`/api/reservations/${checkInId}/check-in`, { method: "PATCH" });
    if (!response.ok) return setStatus(body?.error?.message || "Check-in failed", "error");
    setStatus("Guest check-in recorded.", "success");
    await loadDesk();
  } else if (cancelId) {
    if (!confirm("Cancel this booking?")) return;
    const { response, body } = await request(`/api/reservations/${cancelId}/cancel`, { method: "POST" });
    if (!response.ok) return setStatus(body?.error?.message || "Cancellation failed", "error");
    setStatus("Reservation cancelled.", "success");
    await loadDesk();
  }
});

document.querySelector(".scenario-actions")?.addEventListener("click", async (event) => {
  const scenario = event.target.dataset.scenario;
  if (!scenario) return;
  scenarioResult.textContent = "Running controlled scenario…";

  if (scenario === "auth_failed") {
    const { response, body } = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "staff@staysync.internal", password: "BadPassword123!" })
    });
    scenarioResult.textContent = `${body?.error?.code}: ${body?.error?.message} (HTTP ${response.status}) → Emits auth_login_failed WARNING log`;
    return;
  }

  if (scenario === "unauthorized_desk") {
    const { response, body } = await request("/api/reservations", {
      headers: { "x-demo-scenario": "unauthorized_desk" }
    });
    scenarioResult.textContent = `${body?.error?.code}: ${body?.error?.message} (HTTP ${response.status}) → Emits auth_unauthorized_access WARNING log`;
    return;
  }

  if (scenario === "database_timeout") {
    const { response, body } = await request("/api/rooms?checkIn=2026-12-10&checkOut=2026-12-12&guests=2", {
      headers: { "x-demo-scenario": scenario }
    });
    scenarioResult.textContent = `${body?.error?.code}: ${body?.error?.message} (HTTP ${response.status}) → Emits database_timeout ERROR log`;
    return;
  }

  if (scenario === "traffic_burst") {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request("/api/rooms?checkIn=2027-01-10&checkOut=2027-01-12&guests=2", {
          headers: { "x-demo-scenario": "traffic_burst" }
        })
      )
    );
    scenarioResult.textContent = `Generated ${responses.length} concurrent room searches. Verify Cloud Run concurrency & CPU in Cloud Monitoring.`;
    return;
  }

  if (!activeReservationId) {
    scenarioResult.textContent = "First hold a room above to attach this scenario to a real reservation ID.";
    return;
  }

  const { response, body } = await request("/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-scenario": scenario },
    body: JSON.stringify({ reservationId: activeReservationId })
  });
  scenarioResult.textContent = response.ok
    ? `Scenario completed successfully (${response.status}). Emits latency/worker telemetry.`
    : `${body?.error?.code}: ${body?.error?.message} (HTTP ${response.status}) → Emits payment_provider_rejected ERROR log`;
});

// Initialize on page load
checkSession();

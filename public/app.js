const form = document.querySelector("#search");
const rooms = document.querySelector("#rooms");
const status = document.querySelector("#status");
const journey = document.querySelector("#journey");
const operations = document.querySelector("#operations-list");
const deskLock = document.querySelector("#desk-lock");
const guestReservation = document.querySelector("#guest-reservation");
const scenarioResult = document.querySelector("#scenario-result");
const userBadge = document.querySelector("#user-badge");
const authToggleBtn = document.querySelector("#auth-toggle-btn");
const quickStaffLogin = document.querySelector("#quick-staff-login");

let activeReservationId = null;
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
  if (currentUser && currentUser.role === "staff") {
    userBadge.textContent = `Staff: ${currentUser.name}`;
    userBadge.className = "user-badge staff";
    authToggleBtn.textContent = "Sign Out";
    if (deskLock) deskLock.hidden = true;
    if (operations) operations.hidden = false;
  } else if (currentUser && currentUser.role === "guest") {
    userBadge.textContent = `Guest: ${currentUser.name}`;
    userBadge.className = "user-badge guest";
    authToggleBtn.textContent = "Switch to Staff";
    if (deskLock) deskLock.hidden = false;
    if (operations) operations.hidden = true;
  } else {
    userBadge.textContent = "Guest mode";
    userBadge.className = "user-badge";
    authToggleBtn.textContent = "Staff Login";
    if (deskLock) deskLock.hidden = false;
    if (operations) operations.hidden = true;
  }
}

async function loginAs(email, password) {
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
    setStatus(`Signed in as ${currentUser.name} (${currentUser.role}).`, "success");
    if (currentUser.role === "staff") await loadOperations();
  } else {
    setStatus(body?.error?.message || "Login failed", "error");
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

authToggleBtn?.addEventListener("click", async () => {
  if (currentUser) {
    await logout();
  } else {
    await loginAs("staff@staysync.internal", "DeskPass2026!");
  }
});

quickStaffLogin?.addEventListener("click", async () => {
  await loginAs("staff@staysync.internal", "DeskPass2026!");
});

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
  if (currentUser?.role === "staff") await loadOperations();
}

function renderGuestReservation(reservation, room) {
  guestReservation.innerHTML = `
    <article class="reservation-summary">
      <p class="room-meta">${room.hotel} · ${room.name}</p>
      <h3>${reservation.checkIn} → ${reservation.checkOut}</h3>
      <p>${reservation.guestCount} guests · <span class="state">${reservation.status.replace("_", " ")}</span></p>
      <p class="reference">BOOKING ${reservation.id.slice(0, 8).toUpperCase()}</p>
    </article>
  `;
}

function showJourney(reservation, room) {
  activeReservationId = reservation.id;
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
      <p class="room-meta">${room.hotel} / ${room.housekeepingStatus}</p>
      <h3>${room.name}</h3>
      <p>Sleeps ${room.capacity}. A calm base for the coast and city alike.</p>
      <div class="room-bottom">
        <strong>${money(room.nightlyRateCents)} <small>per night</small></strong>
        <button data-room="${room.id}">Hold room</button>
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
    <a class="button-link" href="#operations">Open hotel desk</a>
  `;
  setStatus(scenario === "slow_payment" ? "Payment was approved after simulated slow response." : "Payment approved and confirmation event queued.", "success");
  renderGuestReservation(body.reservation, { hotel: "Harbor House", name: "Your selected room" });
  if (currentUser?.role === "staff") await loadOperations();
});

async function loadOperations() {
  if (!currentUser || currentUser.role !== "staff") {
    if (deskLock) deskLock.hidden = false;
    if (operations) operations.hidden = true;
    return;
  }
  if (deskLock) deskLock.hidden = true;
  if (operations) operations.hidden = false;

  const { response, body } = await request("/api/reservations");
  if (!response.ok) {
    operations.innerHTML = `<p class="empty">${body?.error?.message || "Could not retrieve desk reservations"}</p>`;
    return;
  }
  operations.innerHTML = body.reservations.length ? body.reservations.map((reservation) => `
    <article class="reservation-row">
      <div>
        <p class="room-meta">${reservation.room.hotel} · ${reservation.room.name}</p>
        <h3>${reservation.checkIn} → ${reservation.checkOut}</h3>
        <p>${reservation.guestCount} guests · <span class="state">${reservation.status.replace("_", " ")}</span></p>
      </div>
      ${reservation.status === "CONFIRMED" ? `<button data-checkin="${reservation.id}">Check in guest</button>` : ""}
    </article>
  `).join("") : `<p class="empty">No reservations yet. Complete a guest booking above to populate the desk.</p>`;
}

document.querySelector("#refresh-ops")?.addEventListener("click", loadOperations);
document.querySelector("#refresh-stay")?.addEventListener("click", loadOperations);

operations?.addEventListener("click", async (event) => {
  const id = event.target.dataset.checkin;
  if (!id) return;
  const { response, body } = await request(`/api/reservations/${id}/check-in`, { method: "PATCH" });
  if (!response.ok) return setStatus(body?.error?.message || "Check-in failed", "error");
  setStatus("Guest check-in recorded.", "success");
  await loadOperations();
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

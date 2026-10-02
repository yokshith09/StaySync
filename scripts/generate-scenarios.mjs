const baseUrl = (process.env.STAYSYNC_URL ?? "http://localhost:8081").replace(/\/$/, "");
const scenario = process.argv[2] ?? "traffic-burst";
const call = async (path, options = {}) => fetch(`${baseUrl}${path}`, options);

if (scenario === "traffic-burst") {
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      call("/api/rooms?checkIn=2027-01-10&checkOut=2027-01-12&guests=2", {
        headers: { "x-demo-scenario": "traffic_burst" }
      })
    )
  );
  console.log(`Generated ${responses.length} successful room-search requests.`);
} else if (scenario === "database-timeout") {
  const response = await call("/api/rooms?checkIn=2027-01-10&checkOut=2027-01-12&guests=2", {
    headers: { "x-demo-scenario": "database_timeout" }
  });
  console.log(`Database timeout scenario returned HTTP ${response.status}:`, await response.text());
} else if (scenario === "auth-failure") {
  const response = await call("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "staff@staysync.internal", password: "BadPassword123!" })
  });
  console.log(`Auth failure scenario returned HTTP ${response.status}:`, await response.text());
} else if (scenario === "unauthorized-desk") {
  const response = await call("/api/reservations", {
    headers: { "x-demo-scenario": "unauthorized_desk" }
  });
  console.log(`Unauthorized desk query returned HTTP ${response.status}:`, await response.text());
} else {
  throw new Error("Valid scenarios: traffic-burst | database-timeout | auth-failure | unauthorized-desk");
}

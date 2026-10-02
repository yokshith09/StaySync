const baseUrl = (process.env.STAYSYNC_URL ?? "http://localhost:8081").replace(/\/$/, "");
const scenario = process.argv[2] ?? "traffic-burst";
const call = async (path, options = {}) => fetch(`${baseUrl}${path}`, options);

if (scenario === "traffic-burst") {
  const responses = await Promise.all(Array.from({ length: 20 }, () => call("/api/rooms?checkIn=2027-01-10&checkOut=2027-01-12&guests=2", { headers: { "x-demo-scenario": "traffic_burst" } })));
  console.log(`Generated ${responses.length} successful room-search requests.`);
} else if (scenario === "database-timeout") {
  const response = await call("/api/rooms?checkIn=2027-01-10&checkOut=2027-01-12&guests=2", { headers: { "x-demo-scenario": "database_timeout" } });
  console.log(await response.text());
} else { throw new Error("Use traffic-burst or database-timeout. Payment scenarios require a held reservation and are available in the app."); }

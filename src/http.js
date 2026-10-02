/**
 * Minimal HTTP response/request helpers shared by every route module.
 * Kept framework-free (Web-standard Request/Response) to match the rest of the app.
 */

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

export const error = (code, message, status, headers = {}) => json({ error: { code, message } }, status, headers);

export const sessionCookie = (token) =>
  `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${24 * 60 * 60}`;

export const clearSessionCookie = () => "session=; HttpOnly; Path=/; Max-Age=0";

export function extractToken(request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) return authHeader.slice(7).trim();
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export const positiveInt = (value) => Number.isInteger(value) && value >= 0;

/** Extracts the path segment at `index` — used for the `/api/orders/:id/...` style routes. */
export const segment = (path, index) => path.split("/")[index];

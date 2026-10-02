import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { resolveMx, resolve4 } from "node:dns/promises";

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, salt, storedHash) {
  const candidate = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "hex");
  const stored = Buffer.from(storedHash, "hex");
  // timingSafeEqual throws on length mismatch, which would leak via a 500 instead of a 401.
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function generateToken() {
  const rawToken = randomBytes(32).toString("hex");
  return { rawToken, tokenHash: hashToken(rawToken) };
}

export function hashToken(rawToken) {
  return createHash("sha256").update(rawToken).digest("hex");
}

// RFC-5322 is not worth reimplementing; this rejects the shapes that break downstream.
export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Best-effort check that an email's domain can receive mail at all: it has an
 * MX record, or — per RFC 5321 §5.1 — falls back to an A record when no MX is
 * published. This rejects registrations against fabricated domains
 * (`nobody@asdkjfh-not-a-real-place.zzz`) without needing a mail provider or
 * sending a real confirmation email, which stay out of scope for this demo.
 * It cannot confirm the specific mailbox exists, only that the domain is real.
 */
export async function hasDeliverableDomain(email) {
  const domain = String(email ?? "").split("@")[1]?.trim();
  if (!domain) return false;

  try {
    if ((await resolveMx(domain)).length > 0) return true;
  } catch {
    /* no MX records published; a bare A record is still a valid mail target */
  }
  try {
    return (await resolve4(domain)).length > 0;
  } catch {
    return false;
  }
}

export const MIN_PASSWORD_LENGTH = 8;

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Per-identifier failed-login throttle.
 *
 * ponytail: in-process Map, so each Cloud Run instance counts separately and the
 * effective limit is attempts x instances. Move to a shared store (Redis, or a
 * table) if the demo ever needs a hard global limit.
 */
export function createLoginThrottle({
  maxAttempts = LOGIN_MAX_ATTEMPTS,
  windowMs = LOGIN_WINDOW_MS,
  now = () => Date.now()
} = {}) {
  const attempts = new Map();

  const prune = (key) => {
    const record = attempts.get(key);
    if (record && now() - record.firstAt > windowMs) {
      attempts.delete(key);
      return null;
    }
    return record ?? null;
  };

  return {
    /** Returns null when the caller may proceed, or { retryAfterSeconds } when blocked. */
    check(identifier) {
      const record = prune(String(identifier ?? "").trim().toLowerCase());
      if (!record || record.count < maxAttempts) return null;
      return { retryAfterSeconds: Math.ceil((record.firstAt + windowMs - now()) / 1000) };
    },

    recordFailure(identifier) {
      const key = String(identifier ?? "").trim().toLowerCase();
      const record = prune(key);
      if (record) record.count += 1;
      else attempts.set(key, { count: 1, firstAt: now() });
      return attempts.get(key).count;
    },

    reset(identifier) {
      attempts.delete(String(identifier ?? "").trim().toLowerCase());
    }
  };
}

// Fixed salts keep the seeded demo accounts byte-identical across migrate runs and in-memory boots.
export const defaultSeedUsers = [
  {
    id: "user-staff-alex",
    email: "staff@staysync.internal",
    name: "Alex Vance",
    role: "staff",
    ...hashPassword("DeskPass2026!", "static-salt-staff-2026")
  },
  {
    id: "user-customer-sarah",
    email: "customer@staysync.internal",
    name: "Sarah Jenkins",
    role: "customer",
    ...hashPassword("ShopPass2026!", "static-salt-customer-2026")
  }
];

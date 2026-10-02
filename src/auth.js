import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, salt, storedHash) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(storedHash, "hex"));
}

export function generateToken() {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

export function hashToken(rawToken) {
  return createHash("sha256").update(rawToken).digest("hex");
}

export const defaultSeedUsers = [
  {
    id: "user-staff-alex",
    email: "staff@staysync.internal",
    name: "Alex Vance",
    role: "staff",
    ...hashPassword("DeskPass2026!", "static-salt-staff-2026")
  },
  {
    id: "user-guest-sarah",
    email: "guest@staysync.internal",
    name: "Sarah Jenkins",
    role: "guest",
    ...hashPassword("GuestPass2026!", "static-salt-guest-2026")
  }
];

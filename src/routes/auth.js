import { json, error, sessionCookie, clearSessionCookie } from "../http.js";
import { isValidEmail, MIN_PASSWORD_LENGTH, LOGIN_MAX_ATTEMPTS } from "../auth.js";

export const authRoutes = [
  {
    method: "POST",
    match: (path) => path === "/api/auth/register",
    async handler({ store, requestBody, checkEmailDomain }) {
      const name = requestBody?.name?.trim();
      const email = requestBody?.email?.trim();
      const component = "auth";

      if (!name || !isValidEmail(email) || (requestBody?.password ?? "").length < MIN_PASSWORD_LENGTH) {
        return {
          response: error(
            "VALIDATION_ERROR",
            `A name, a valid email address, and a password of at least ${MIN_PASSWORD_LENGTH} characters are required`,
            422
          ),
          event: "auth_register_invalid",
          component,
          severity: "WARNING",
          message: "Registration validation failed"
        };
      }

      // Rejects fabricated domains without a mail provider or a real confirmation email —
      // see hasDeliverableDomain() in auth.js for exactly what this does and does not prove.
      if (!(await checkEmailDomain(email))) {
        return {
          response: error(
            "EMAIL_DOMAIN_UNREACHABLE",
            "We could not find a mail server for this email's domain. Please check for a typo.",
            422
          ),
          event: "auth_register_domain_unreachable",
          component,
          severity: "WARNING",
          message: "Registration rejected: the email domain has no reachable mail server"
        };
      }

      const result = await store.registerUser({ name, email, password: requestBody.password });
      if (result.kind === "email_exists") {
        return {
          response: error("EMAIL_EXISTS", "An account with this email address already exists", 409),
          event: "auth_register_duplicate",
          component,
          severity: "WARNING",
          message: "Registration rejected as a duplicate email"
        };
      }

      return {
        response: json({ token: result.token, user: result.user }, 201, { "Set-Cookie": sessionCookie(result.token) }),
        event: "auth_register_success",
        component,
        message: "New customer registered and session established"
      };
    }
  },

  {
    method: "POST",
    match: (path) => path === "/api/auth/login",
    async handler({ store, requestBody, loginThrottle }) {
      const component = "auth";
      const email = requestBody?.email;
      const blocked = email ? loginThrottle.check(email) : null;

      if (!email || !requestBody?.password) {
        return {
          response: error("VALIDATION_ERROR", "Email and password are required", 422),
          event: "auth_login_invalid",
          component,
          severity: "WARNING",
          message: "Missing login parameters"
        };
      }

      if (blocked) {
        // Refused before touching the store, so a brute-force burst cannot drive database load.
        return {
          response: error(
            "TOO_MANY_ATTEMPTS",
            `Too many failed sign-in attempts. Try again in ${Math.ceil(blocked.retryAfterSeconds / 60)} minutes.`,
            429,
            { "Retry-After": String(blocked.retryAfterSeconds) }
          ),
          event: "auth_rate_limited",
          component,
          severity: "WARNING",
          message: "Sign-in refused: too many failed attempts for this account"
        };
      }

      const user = await store.authenticateUser(requestBody);
      if (!user) {
        const attempts = loginThrottle.recordFailure(email);
        return {
          response: error("INVALID_CREDENTIALS", "Invalid email or password", 401),
          event: "auth_login_failed",
          component,
          severity: "WARNING",
          message: `Login attempt failed (${attempts} of ${LOGIN_MAX_ATTEMPTS} before lockout)`
        };
      }

      loginThrottle.reset(email);
      const session = await store.createSession(user.id);
      return {
        response: json({ token: session.token, user: session.user }, 200, {
          "Set-Cookie": sessionCookie(session.token)
        }),
        event: "auth_login_success",
        component,
        message: `Signed in with role ${session.user.role}`
      };
    }
  },

  {
    method: "POST",
    match: (path) => path === "/api/auth/logout",
    async handler({ store, rawToken }) {
      if (rawToken) await store.deleteSession(rawToken);
      return {
        response: json({ success: true }, 200, { "Set-Cookie": clearSessionCookie() }),
        event: "auth_logout",
        component: "auth",
        message: "Session terminated"
      };
    }
  },

  {
    method: "GET",
    match: (path) => path === "/api/auth/me",
    async handler({ currentUser }) {
      const component = "auth";
      if (!currentUser) {
        return {
          response: error("UNAUTHORIZED", "Not signed in", 401),
          event: "auth_unauthenticated",
          component,
          message: "No active session"
        };
      }
      return {
        response: json({ user: currentUser }),
        event: "auth_profile_viewed",
        component,
        message: "Session validated"
      };
    }
  }
];

// public/api.js
const BASE = ""; // same-origin. If your frontend is on a different origin, set e.g. 'https://app.example.com'

async function request(path, { method = "GET", body, headers = {}, ...rest } = {}) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",              // ← sends/receives the HttpOnly cookie
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...rest,
  });

  const text = await res.text();
  const data = text
    ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })()
    : null;

  if (!res.ok) {
    const message = data?.error || data?.message || res.statusText;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- Budget endpoints ----
export const BudgetAPI = {
  login: (budgetNumber, holderName, pin) =>
    request("/api/budget/login", { method: "POST", body: { budgetNumber, holderName, pin } }),

  me: () => request("/api/budget/me"),

  logout: () => request("/api/budget/logout", { method: "POST" }),

  listBookings: ({ dateFrom, dateTo, status, page = 1, limit = 50 } = {}) => {
    const qs = new URLSearchParams();
    if (dateFrom) qs.set("dateFrom", dateFrom);
    if (dateTo) qs.set("dateTo", dateTo);
    if (status) qs.set("status", status);
    qs.set("page", String(page));
    qs.set("limit", String(limit));
    return request(`/api/budget/bookings?${qs.toString()}`);
  },

  getBooking: (id) => request(`/api/budget/bookings/${encodeURIComponent(id)}`),

  // Approve booking
  approve: (id) =>
    request(`/api/budget/bookings/${encodeURIComponent(id)}/approve`, {
      method: "PATCH",
    }),

  // Decline booking with optional reason
  decline: (id, reason = "") =>
    request(`/api/budget/bookings/${encodeURIComponent(id)}/decline`, {
      method: "PATCH",
      body: { reason },
    }),

  // Update core fields only (no re-geocoding)
  update: (id, payload) =>
    request(`/api/budget/bookings/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: payload,
    }),

  // Update and re-geocode if pickup/destination text/postcode provided
  updateWithGeocode: (id, payload) =>
    request(`/api/budget/bookings/${encodeURIComponent(id)}/customer-update`, {
      method: "POST",
      body: payload,
    }),

  // Optional: cancel via budget portal (if you expose it)
  cancelBooking: (id, reason) =>
    request(`/api/budget/bookings/${encodeURIComponent(id)}/cancel`, {
      method: "PATCH",
      body: { reason },
    }),
};

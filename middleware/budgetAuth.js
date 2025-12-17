import jwt from "jsonwebtoken";

const COOKIE_NAME = "budget_token";
const JWT_SECRET = process.env.JWT_BUDGET_SECRET || "dev-secret-change-me";
const MAX_AGE = 12 * 60 * 60; // 12h

export function signBudgetToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: MAX_AGE });
}

export function requireBudget(req, res, next) {
  try {
    const raw = req.cookies?.[COOKIE_NAME] || "";
    const decoded = jwt.verify(raw, JWT_SECRET);
    req.budgetContext = decoded; // { budgetNumber, holderName }
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorised" });
  }
}

export function setBudgetCookie(res, token) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: MAX_AGE * 1000,
    path: "/",
  });
}

export function clearBudgetCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

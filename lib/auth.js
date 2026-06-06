/**
 * Lightweight session auth for the ops dashboard.
 *
 * A successful login sets an HttpOnly cookie containing `${expiry}.${hmac}`,
 * where the HMAC is signed with DASHBOARD_SECRET. No database needed — the
 * cookie is self-verifying. Single operator model (one username/password).
 */
const crypto = require("crypto");

const COOKIE = "sw_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // stay signed in for 7 days

function secret() {
  return process.env.DASHBOARD_SECRET || "";
}

function sign(exp) {
  return crypto.createHmac("sha256", secret()).update(String(exp)).digest("hex");
}

function createToken() {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  if (!token || !secret()) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** True if the request carries a valid, unexpired session cookie. */
function verifySession(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function sessionCookie() {
  return `${COOKIE}=${createToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Constant-time string comparison (avoids leaking length/timing on creds). */
function timingEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { verifySession, sessionCookie, clearCookie, timingEqualStr, COOKIE };

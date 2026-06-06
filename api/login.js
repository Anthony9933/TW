/**
 * POST /api/login
 *   { username, password }  -> sets session cookie on success
 *   { logout: true }        -> clears the session cookie
 */
const { sessionCookie, clearCookie, timingEqualStr } = require("../lib/auth");

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = await readJson(req);

  if (body.logout) {
    res.setHeader("Set-Cookie", clearCookie());
    return res.status(200).json({ ok: true });
  }

  const U = process.env.DASHBOARD_USERNAME;
  const P = process.env.DASHBOARD_PASSWORD;
  const S = process.env.DASHBOARD_SECRET;
  if (!U || !P || !S) {
    return res.status(503).json({
      error:
        "Login is not configured. Set DASHBOARD_USERNAME, DASHBOARD_PASSWORD, and DASHBOARD_SECRET.",
    });
  }

  // Evaluate both so timing doesn't reveal which field was wrong.
  const okUser = timingEqualStr(body.username || "", U);
  const okPass = timingEqualStr(body.password || "", P);
  if (okUser && okPass) {
    res.setHeader("Set-Cookie", sessionCookie());
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ error: "Invalid username or password" });
};

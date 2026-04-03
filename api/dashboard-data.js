const { getDashboardSnapshot } = require("../lib/analytics");

/**
 * GET /api/dashboard-data
 * Auth: Authorization: Bearer <DASHBOARD_SECRET> or ?secret= (less secure)
 */
module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return res.status(204).end();
  }

  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: "DASHBOARD_SECRET is not set. Add it in your environment.",
    });
  }

  const auth = req.headers.authorization || "";
  let qsecret;
  try {
    const u = new URL(req.url || "/", "http://localhost");
    qsecret = u.searchParams.get("secret");
  } catch (_) {
    qsecret = undefined;
  }
  if (!qsecret && typeof req.query === "object" && req.query?.secret) {
    qsecret = req.query.secret;
  }
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : qsecret;

  if (token !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const data = await getDashboardSnapshot();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (e) {
    console.error("dashboard-data error:", e);
    return res.status(500).json({ error: "Failed to load analytics" });
  }
};

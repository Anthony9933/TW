const fs = require("fs");
const path = require("path");

/**
 * Serves the operations dashboard HTML.
 * Vercel bundles `public/dashboard.html` via vercel.json includeFiles so this always works in production.
 */
module.exports = function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).send("Method Not Allowed");
  }

  const filePath = path.join(__dirname, "..", "public", "dashboard.html");
  try {
    const html = fs.readFileSync(filePath, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    return res.status(200).send(html);
  } catch (e) {
    console.error("[dashboard] read dashboard.html:", e);
    return res
      .status(500)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        "<!DOCTYPE html><html><body style='font-family:sans-serif;padding:2rem'><h1>Dashboard file missing</h1><p>Ensure <code>public/dashboard.html</code> is deployed and <code>api/dashboard.js</code> has <code>includeFiles</code> in vercel.json.</p></body></html>"
      );
  }
};

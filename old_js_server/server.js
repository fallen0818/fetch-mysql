require("dotenv").config();

const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

const REQUIRED_ENV = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});
app.use("/api", apiLimiter);

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const MONTH_COLUMN_REGEX = /^kwh\d{6}$/;
const MAX_QUERY_LENGTH = 200;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function normalizeCustomer(row) {
  // Build a case-insensitive lookup so any column casing works
  const ci = {};
  for (const key of Object.keys(row)) {
    ci[key.toLowerCase()] = row[key];
  }

  return {
    customerid: ci.customerid ?? null,
    ctype: ci.ctype ?? "",
    caddress: ci.caddress ?? "",
    Barangay: ci.barangay ?? "",
    Town: ci.town ?? "",
    RouteNumber: ci.routenumber ?? 0,
    cname: ci.cname ?? "",
    status: ci.status ?? "Active",
    kwh: Number(ci.kwh ?? 0),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

async function getAvailableKwhMonths() {
  const [results] = await pool.query("SHOW COLUMNS FROM tblkwh LIKE 'kwh%'");
  return (results || [])
    .map((row) => row.Field)
    .filter((field) => MONTH_COLUMN_REGEX.test(field))
    .sort();
}

function resolveSelectedMonth(availableMonths, requested) {
  if (requested && availableMonths.includes(requested)) {
    return requested;
  }
  const fallback = "kwh202607";
  if (availableMonths.includes(fallback)) return fallback;
  return availableMonths[availableMonths.length - 1] || null;
}

// ---------------------------------------------------------------------------
// Routes — /api/months
// ---------------------------------------------------------------------------

app.get("/api/months", async (req, res, next) => {
  try {
    const availableMonths = await getAvailableKwhMonths();
    const defaultMonth = resolveSelectedMonth(availableMonths, null);

    return res.json({ months: availableMonths, defaultMonth });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Routes — /api/customers
// ---------------------------------------------------------------------------

app.get("/api/customers", async (req, res, next) => {
  try {
    // --- Parse & sanitise inputs -----------------------------------------
    const query = String(req.query.q || "")
      .trim()
      .slice(0, MAX_QUERY_LENGTH);
    const status = String(req.query.status || "").trim().slice(0, 50);
    const routeNumber = String(req.query.routeNumber || "").trim();
    const month = String(req.query.month || "").trim();

    const page = clampInt(req.query.page, 1, 10000, 1);
    const pageSize = clampInt(req.query.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    // --- Resolve the kwh month column ------------------------------------
    const availableMonths = await getAvailableKwhMonths();
    const selectedMonth = resolveSelectedMonth(availableMonths, month);

    if (!selectedMonth) {
      return res.status(400).json({ message: "No kwh month data available." });
    }

    // Safety: even though we validated against DB columns, enforce the regex
    if (!MONTH_COLUMN_REGEX.test(selectedMonth)) {
      return res.status(400).json({ message: "Invalid month parameter." });
    }

    // --- Build WHERE clause ----------------------------------------------
    const conditions = [];
    const params = [];

    if (query) {
      conditions.push(
        "(UPPER(c.CNAME) LIKE UPPER(?) OR UPPER(c.CTYPE) LIKE UPPER(?) OR UPPER(c.CADDRESS) LIKE UPPER(?) OR UPPER(c.BARANGAY) LIKE UPPER(?) OR UPPER(c.TOWN) LIKE UPPER(?))"
      );
      const wildcard = `%${query}%`;
      params.push(wildcard, wildcard, wildcard, wildcard, wildcard);
    }

    if (status) {
      conditions.push("LOWER(c.STATUS) = LOWER(?)");
      params.push(status);
    }

    if (routeNumber) {
      const rn = Number(routeNumber);
      if (Number.isFinite(rn)) {
        conditions.push("c.ROUTENUMBER = ?");
        params.push(rn);
      }
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    // --- Count query ------------------------------------------------------
    const countSql = `
      SELECT COUNT(*) AS total
      FROM tblcustomer c
      LEFT JOIN tblkwh k ON k.customerid = c.customerid
      ${whereClause}
    `;
    const [countRows] = await pool.query(countSql, params);
    const total = Number(countRows[0]?.total ?? 0);

    // --- Data query -------------------------------------------------------
    const dataSql = `
      SELECT c.*, k.\`${selectedMonth}\` AS kwh
      FROM tblcustomer c
      LEFT JOIN tblkwh k ON k.customerid = c.customerid
      ${whereClause}
      ORDER BY c.customerid DESC
      LIMIT ? OFFSET ?
    `;
    const [dataRows] = await pool.query(dataSql, [...params, pageSize, offset]);

    const normalized = (dataRows || []).map(normalizeCustomer);
    const totalKwh = normalized.reduce((sum, row) => sum + row.kwh, 0);

    return res.json({
      results: normalized,
      total,
      page,
      pageSize,
      totalPages: total > 0 ? Math.ceil(total / pageSize) : 0,
      selectedMonth,
      totalKwh,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Routes — /api/customer/:id/history
// ---------------------------------------------------------------------------

app.get("/api/customer/:id/history", async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);

    if (!Number.isFinite(customerId) || customerId <= 0) {
      return res
        .status(400)
        .json({ message: "A valid numeric customer id is required." });
    }

    const sql = `
      SELECT c.*, k.*
      FROM tblcustomer c
      LEFT JOIN tblkwh k ON k.customerid = c.customerid
      WHERE c.customerid = ?
      LIMIT 1
    `;
    const [results] = await pool.query(sql, [customerId]);

    if (!results || results.length === 0) {
      return res.status(404).json({ message: "Customer not found." });
    }

    const customerData = results[0];

    const history = Object.keys(customerData)
      .filter((key) => MONTH_COLUMN_REGEX.test(key))
      .map((key) => {
        const month = key.slice(3, 9);
        const label = `${month.slice(0, 4)}-${month.slice(4, 6)}`;
        return { month: key, label, value: Number(customerData[key] ?? 0) };
      })
      .sort((a, b) => a.month.localeCompare(b.month));

    return res.json({
      customer: normalizeCustomer(customerData),
      history,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// API 404 — catch unknown /api routes before the SPA fallback
// ---------------------------------------------------------------------------

app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found." });
});

// ---------------------------------------------------------------------------
// SPA fallback — everything else serves the front-end
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------------
// Centralised error handler
// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error("[server error]", err);

  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error."
      : err.message || "Internal server error.";

  res.status(statusCode).json({ message });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully.`);
  try {
    await pool.end();
    console.log("Database pool closed.");
  } catch (err) {
    console.error("Error closing pool:", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Customer search is running at http://localhost:${PORT}`);
});
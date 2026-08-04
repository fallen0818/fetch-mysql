const express = require("express");
const mysql = require("mysql2");
const serverless = require("serverless-http");

const app = express();

const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "0818",
  database: process.env.DB_NAME || "dbpanelco",
  port: Number(process.env.DB_PORT || 3306),
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function createDbConnection() {
  return mysql.createConnection(DB_CONFIG);
}

function normalizeCustomer(row) {
  return {
    customerid: row.customerid ?? row.CustomerID ?? row.customerId,
    ctype: row.ctype ?? "",
    caddress: row.caddress ?? "",
    Barangay: row.Barangay ?? "",
    Town: row.Town ?? "",
    RouteNumber: row.RouteNumber ?? 0,
    cname: row.cname ?? "",
    status: row.status ?? "Active",
    kwh: Number(row.kwh ?? 0),
  };
}

async function getAvailableKwhMonths(connection) {
  return new Promise((resolve, reject) => {
    connection.query(
      "SHOW COLUMNS FROM tblkwh LIKE 'kwh%'",
      (error, results) => {
        if (error) {
          reject(error);
          return;
        }

        const months = (results || []).map((row) => row.Field).sort();
        resolve(months);
      },
    );
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "dbpanelco API is live" });
});

app.get("/api/months", async (req, res) => {
  try {
    const connection = createDbConnection();
    const availableMonths = await getAvailableKwhMonths(connection);
    const defaultMonth = availableMonths.includes("kwh202607")
      ? "kwh202607"
      : availableMonths[availableMonths.length - 1] || "kwh202607";

    connection.end();

    return res.json({ months: availableMonths, defaultMonth });
  } catch (error) {
    return res.status(500).json({
      message: "Unable to load month metadata.",
      error: error.message,
    });
  }
});

app.get("/api/customers", async (req, res) => {
  const query = String(req.query.q || "").trim();
  const status = String(req.query.status || "").trim();
  const routeNumber = String(req.query.routeNumber || "").trim();
  const month = String(req.query.month || "").trim();
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 20);
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const safePageSize =
    Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20;
  const offset = (safePage - 1) * safePageSize;

  try {
    const connection = createDbConnection();
    const availableMonths = await getAvailableKwhMonths(connection);
    const defaultMonth = availableMonths.includes("kwh202607")
      ? "kwh202607"
      : availableMonths[availableMonths.length - 1] || "kwh202607";
    const selectedMonth = availableMonths.includes(month)
      ? month
      : defaultMonth;

    const data = await new Promise((resolve, reject) => {
      connection.connect((error) => {
        if (error) {
          reject(error);
          return;
        }

        const conditions = [];
        const params = [];

        if (query) {
          conditions.push(
            "(LOWER(c.cname) LIKE LOWER(?) OR LOWER(c.ctype) LIKE LOWER(?) OR LOWER(c.caddress) LIKE LOWER(?) OR LOWER(c.Barangay) LIKE LOWER(?) OR LOWER(c.Town) LIKE LOWER(?))",
          );
          params.push(
            `%${query}%`,
            `%${query}%`,
            `%${query}%`,
            `%${query}%`,
            `%${query}%`,
          );
        }

        if (status) {
          conditions.push("LOWER(c.status) = LOWER(?)");
          params.push(status);
        }

        if (routeNumber) {
          conditions.push("c.RouteNumber = ?");
          params.push(Number(routeNumber));
        }

        const whereClause = conditions.length
          ? `WHERE ${conditions.join(" AND ")}`
          : "";

        const countSql = `SELECT COUNT(*) AS total FROM tblcustomer c LEFT JOIN tblkwh k ON k.customerid = c.customerid ${whereClause}`;

        connection.query(countSql, params, (countError, countRows) => {
          if (countError) {
            connection.end();
            reject(countError);
            return;
          }

          const total = Number(countRows[0]?.total ?? 0);

          const sql = `
            SELECT c.*, k.${selectedMonth} AS kwh
            FROM tblcustomer c
            LEFT JOIN tblkwh k ON k.customerid = c.customerid
            ${whereClause}
            ORDER BY c.customerid DESC
            LIMIT ? OFFSET ?
          `;

          connection.query(
            sql,
            [...params, safePageSize, offset],
            (queryError, results) => {
              connection.end();

              if (queryError) {
                reject(queryError);
                return;
              }

              const normalized = (results || []).map(normalizeCustomer);
              const totalKwh = normalized.reduce(
                (sum, row) => sum + Number(row.kwh || 0),
                0,
              );

              resolve({
                results: normalized,
                total,
                page: safePage,
                pageSize: safePageSize,
                totalPages: total > 0 ? Math.ceil(total / safePageSize) : 0,
                selectedMonth,
                totalKwh,
              });
            },
          );
        });
      });
    });

    return res.json(data);
  } catch (error) {
    return res.status(500).json({
      message: "Unable to search customers right now.",
      error: error.message,
    });
  }
});

app.get("/api/customer/:id/history", async (req, res) => {
  const customerId = Number(req.params.id);

  if (!customerId) {
    return res.status(400).json({ message: "Customer id is required." });
  }

  try {
    const connection = createDbConnection();
    const customerData = await new Promise((resolve, reject) => {
      connection.connect((error) => {
        if (error) {
          reject(error);
          return;
        }

        const sql = `
          SELECT c.*, k.*
          FROM tblcustomer c
          LEFT JOIN tblkwh k ON k.customerid = c.customerid
          WHERE c.customerid = ?
          LIMIT 1
        `;

        connection.query(sql, [customerId], (queryError, results) => {
          connection.end();

          if (queryError) {
            reject(queryError);
            return;
          }

          resolve(results && results[0] ? results[0] : null);
        });
      });
    });

    if (!customerData) {
      return res.status(404).json({ message: "Customer not found." });
    }

    const history = Object.keys(customerData)
      .filter((key) => /^kwh\d{6}$/.test(key))
      .map((key) => {
        const month = key.slice(3, 9);
        const label = `${month.slice(0, 4)}-${month.slice(4, 6)}`;
        return {
          month: key,
          label,
          value: Number(customerData[key] ?? 0),
        };
      })
      .sort((a, b) => a.month.localeCompare(b.month));

    return res.json({
      customer: normalizeCustomer(customerData),
      history,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Unable to load customer KWh history.",
      error: error.message,
    });
  }
});

module.exports = app;
module.exports.handler = serverless(app);

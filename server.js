const express = require("express");
const path = require("path");
const mysql = require("mysql2");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "0818",
  database: process.env.DB_NAME || "dbpanelco",
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/api/customers", async (req, res) => {
  const query = String(req.query.q || "").trim();
  const status = String(req.query.status || "").trim();
  const routeNumber = String(req.query.routeNumber || "").trim();
  const month = String(req.query.month || "kwh202607").trim();
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.pageSize || 20);
  const allowedMonths = [
    "kwh202401",
    "kwh202402",
    "kwh202403",
    "kwh202404",
    "kwh202405",
    "kwh202406",
    "kwh202407",
    "kwh202408",
    "kwh202409",
    "kwh202410",
    "kwh202411",
    "kwh202412",
    "kwh202501",
    "kwh202502",
    "kwh202503",
    "kwh202504",
    "kwh202505",
    "kwh202506",
    "kwh202507",
    "kwh202508",
    "kwh202509",
    "kwh202510",
    "kwh202511",
    "kwh202512",
    "kwh202601",
    "kwh202602",
    "kwh202603",
    "kwh202604",
    "kwh202605",
    "kwh202606",
    "kwh202607",
  ];
  const selectedMonth = allowedMonths.includes(month) ? month : "kwh202607";
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const safePageSize =
    Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20;
  const offset = (safePage - 1) * safePageSize;

  try {
    const connection = createDbConnection();

    const rows = await new Promise((resolve, reject) => {
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

    return res.json(rows);
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

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Customer search is running at http://localhost:${PORT}`);
});

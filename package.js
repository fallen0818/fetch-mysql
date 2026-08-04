const fs = require("fs");
const path = require("path");
const mysql = require("mysql2");

const SOURCE_DB = {
  host: process.env.SOURCE_HOST || process.env.DB_HOST || "localhost",
  user: process.env.SOURCE_USER || process.env.DB_USER || "root",
  password: process.env.SOURCE_PASSWORD || process.env.DB_PASSWORD || "0818",
  database: process.env.SOURCE_DATABASE || process.env.DB_NAME || "sample_src",
};

const TARGET_DB = {
  host: process.env.TARGET_HOST || process.env.DB_HOST || "localhost",
  user: process.env.TARGET_USER || process.env.DB_USER || "root",
  password: process.env.TARGET_PASSWORD || process.env.DB_PASSWORD || "0818",
  database: process.env.TARGET_DATABASE || process.env.DB_NAME || "sample_src",
};

function getConnectionConfig(config, label) {
  if (!config.database) {
    throw new Error(
      `${label} database is required. Set ${label.toUpperCase()}_DATABASE or DB_NAME.`,
    );
  }

  return {
    host: config.host,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: true,
  };
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection(config);

    connection.connect((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(connection);
    });
  });
}

function query(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

async function getTableNames(connection, databaseName) {
  const rows = await query(
    connection,
    'SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = "BASE TABLE" ORDER BY table_name',
    [databaseName],
  );

  return rows
    .map((row) => row.table_name || row.TABLE_NAME)
    .filter((tableName) => Boolean(tableName));
}

async function getCreateTableSql(connection, tableName) {
  if (!tableName) {
    throw new Error("Table name is required to fetch schema.");
  }

  const escapedTableName = mysql.escapeId(tableName);
  const rows = await query(connection, `SHOW CREATE TABLE ${escapedTableName}`);
  const createSql = rows[0]["Create Table"] || rows[0]["Create View"];

  if (!createSql) {
    throw new Error(`Could not read schema for table ${tableName}`);
  }

  return createSql;
}

async function getTableRows(connection, tableName) {
  const escapedName = mysql.escapeId(tableName);
  return query(connection, `SELECT * FROM ${escapedName}`);
}

function escapeValue(value) {
  if (value === null || typeof value === "undefined") {
    return "NULL";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function buildInsertStatements(tableName, rows) {
  if (!rows.length) {
    return [];
  }

  const columns = Object.keys(rows[0]);
  const escapedColumns = columns
    .map((column) => mysql.escapeId(column))
    .join(", ");
  const statements = rows.map((row) => {
    const values = columns.map((column) => escapeValue(row[column]));
    return `INSERT INTO ${mysql.escapeId(tableName)} (${escapedColumns}) VALUES (${values.join(", ")});`;
  });

  return statements;
}

function buildSqlDump(snapshot) {
  const lines = [];

  snapshot.schema.forEach((statement) => {
    lines.push(`${statement};`);
  });

  Object.entries(snapshot.data).forEach(([tableName, rows]) => {
    const insertStatements = buildInsertStatements(tableName, rows);
    lines.push(...insertStatements);
  });

  return `${lines.join("\n")}\n`;
}

async function fetchDatabaseSnapshot(connection, databaseName) {
  const tableNames = await getTableNames(connection, databaseName);
  const schema = [];
  const data = {};

  if (!tableNames.length) {
    console.warn(`No tables found in database ${databaseName}.`);
  }

  for (const tableName of tableNames) {
    const createSql = await getCreateTableSql(connection, tableName);
    schema.push(createSql);
    data[tableName] = await getTableRows(connection, tableName);
  }

  return {
    database: databaseName,
    tables: tableNames,
    schema,
    data,
  };
}

function ensureDumpDirectory() {
  const dumpDir = path.join(process.cwd(), "dump");
  fs.mkdirSync(dumpDir, { recursive: true });
  return dumpDir;
}

function saveSnapshot(snapshot) {
  const dumpDir = ensureDumpDirectory();
  const fileBase = path.join(dumpDir, snapshot.database);
  const sqlFile = `${fileBase}.sql`;
  const jsonFile = `${fileBase}.json`;

  fs.writeFileSync(sqlFile, buildSqlDump(snapshot), "utf8");
  fs.writeFileSync(jsonFile, JSON.stringify(snapshot, null, 2), "utf8");

  console.log(
    `Saved schema and data for ${snapshot.database} to ${sqlFile} and ${jsonFile}`,
  );
}

async function loadSnapshot(databaseName) {
  const dumpDir = path.join(process.cwd(), "dump");
  const jsonFile = path.join(dumpDir, `${databaseName}.json`);

  if (!fs.existsSync(jsonFile)) {
    throw new Error(
      `Snapshot not found at ${jsonFile}. Run "node package.js fetch" first.`,
    );
  }

  return JSON.parse(fs.readFileSync(jsonFile, "utf8"));
}

function makeCreateTableSafe(statement) {
  return statement.replace(
    /^CREATE\s+TABLE\s+/i,
    "CREATE TABLE IF NOT EXISTS ",
  );
}

async function applySnapshotToTarget(snapshot) {
  const targetConfig = getConnectionConfig(TARGET_DB, "Target");
  const targetConnection = await connect(targetConfig);

  try {
    for (const statement of snapshot.schema) {
      await query(targetConnection, makeCreateTableSafe(statement));
    }

    for (const [tableName, rows] of Object.entries(snapshot.data)) {
      if (!rows.length) {
        continue;
      }

      const columns = Object.keys(rows[0]);
      const insertSql = `INSERT IGNORE INTO ${mysql.escapeId(tableName)} (${columns.map((column) => mysql.escapeId(column)).join(", ")}) VALUES ?`;
      const values = rows.map((row) => columns.map((column) => row[column]));
      await query(targetConnection, insertSql, [values]);
    }

    console.log(
      `Pushed ${snapshot.database} schema and data to target database ${targetConfig.database}`,
    );
  } finally {
    targetConnection.end();
  }
}

async function runFetch() {
  const sourceConfig = getConnectionConfig(SOURCE_DB, "Source");
  const sourceConnection = await connect(sourceConfig);

  try {
    const snapshot = await fetchDatabaseSnapshot(
      sourceConnection,
      sourceConfig.database,
    );
    saveSnapshot(snapshot);
    return snapshot;
  } finally {
    sourceConnection.end();
  }
}

async function runPush() {
  const snapshot = await loadSnapshot(
    TARGET_DB.database || SOURCE_DB.database || "database",
  );
  await applySnapshotToTarget(snapshot);
}

async function runSync() {
  const snapshot = await runFetch();
  await applySnapshotToTarget(snapshot);
}

async function main() {
  const [command] = process.argv.slice(2);

  try {
    switch (command) {
      case "fetch":
        await runFetch();
        break;
      case "push":
        await runPush();
        break;
      case "sync":
        await runSync();
        break;
      case "help":
      case "--help":
      case "-h":
      default:
        console.log("Usage: node package.js <fetch|push|sync>");
        console.log(
          "Environment variables: SOURCE_HOST, SOURCE_USER, SOURCE_PASSWORD, SOURCE_DATABASE",
        );
        console.log(
          "                     TARGET_HOST, TARGET_USER, TARGET_PASSWORD, TARGET_DATABASE",
        );
        console.log(
          "                     DB_HOST, DB_USER, DB_PASSWORD, DB_NAME as shared aliases",
        );
        break;
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exitCode = 1;
  }
}

main();

// The protocol formats of Zira's generic collection, checked locally before any call.
//
// Source of truth: the collector's own schemas and parsers, platform
// src/collectionRunner/drivers/modbusTcp/schemas.ts and drivers/postgres/schemas.ts, and its secret rules
// (core/secrets.ts). Keep these checks identical to them. The collection API stores connection, address and
// source as free JSON objects, so a mistake here would only show up when the collector polls.
// Gateway timing limits are zira-web's endpoint form (src/lib/collection/protocols.js), with the collector's
// 60-second minimum poll interval.

const object = v => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const nonBlank = v => typeof v === "string" && v.trim() !== "";

export const invalid = message => Object.assign(new Error(message), { invalid: true });

export const SECRET_KEY = "$secret";

// { "$secret": "<key>" } and nothing else (core/secrets.ts secretRefKey).
export function secretRefKey(value) {
  if (!object(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === SECRET_KEY && nonBlank(value[SECRET_KEY]) ? value[SECRET_KEY].trim() : undefined;
}

// Every secret reference in a connection: [{ field: "connection.user", key: "username" }].
export function secretRefs(connection, path = "connection") {
  const key = secretRefKey(connection);
  if (key) return [{ field: path, key }];
  if (Array.isArray(connection)) return connection.flatMap((v, i) => secretRefs(v, `${path}[${i}]`));
  if (object(connection)) return Object.entries(connection).flatMap(([k, v]) => secretRefs(v, `${path}.${k}`));
  return [];
}

// Names that hold a secret. A plain value under one of them is refused for every protocol.
const SECRET_NAME = /pass(word|wd)?$|^pwd$|secret|token|api_?key|private_?key/i;

// The one parameter per gateway that holds its secret values (core/secrets.ts parameterName). The prefix is
// the platform's fixed AWS path, not a product name: it must match the real parameter, like a GitHub address.
export const PARAMETER_PREFIX = "/zira/collection/";
export const parameterName = (companyId, endpointId) => `${PARAMETER_PREFIX}${companyId}/endpoint-${endpointId}`;

const TABLES = ["holding", "input", "coil", "discrete"];
const TYPES = ["int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64", "bool"];
const ORDERS = ["big", "little"];
const REGISTERS = { int16: 1, uint16: 1, bool: 1, int32: 2, uint32: 2, float32: 2, int64: 4, uint64: 4, float64: 4 };
const SSL = ["require", "verify-full", "disable"];
const MAX_QUERY = 10000;
const MAX_ROWS = 5000;

function onlyKeys(value, allowed, what) {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) throw invalid(`${what} has unknown keys (${extra.join(", ")}). Allowed: ${allowed.join(", ")}. Run formats to see the exact format.`);
}

// What each protocol's connection, address and map source look like, with one example each.
export const PROTOCOLS = {
  modbus_tcp: {
    title: "Modbus TCP (power meters and sensors behind a Modbus TCP gateway)",
    secretFields: [],
    connection: {
      fields: {
        host: "required: the gateway's IP address or host name, as the collector reaches it (a public address, or the site's VPN address)",
        port: "optional whole number 1-65535, default 502",
      },
      example: { host: "10.0.0.20", port: 502 },
    },
    address: {
      fields: { unit_id: "required: the meter's Modbus unit ID (slave ID) behind the gateway, a whole number 0-255" },
      example: { unit_id: 1 },
    },
    source: {
      fields: {
        table: `required: ${TABLES.join(" | ")} (holding registers, input registers, coils, discrete inputs)`,
        register: "required: the 0-based register address, 0-65535 (a meter manual's 30012 or 40012 is often register 11)",
        type: `required: ${TYPES.join(" | ")}`,
        word_order: "optional: big (high word first, the default) | little (low word first), for 32- and 64-bit types",
        byte_order: "optional: big (default) | little",
        bit: "optional: one bit 0-15 of a 16-bit register",
      },
      example: { table: "input", register: 11, type: "int32", word_order: "big" },
    },
    map: { metricId: "1", source: { table: "input", register: 11, type: "int32", word_order: "big" }, scale: 0.001, valueOffset: 0, isEnabled: true },
  },
  postgres: {
    title: "PostgreSQL (a customer's database, read with a SELECT query)",
    secretFields: ["user", "password"],
    connection: {
      fields: {
        host: "required: the database's host name or IP address",
        port: "optional whole number 1-65535, default 5432",
        database: "required: the database name",
        user: 'required, always the reference { "$secret": "username" }, never the user name itself',
        password: 'required, always the reference { "$secret": "password" }, never the password itself',
        ssl: `optional: ${SSL.join(" | ")}, default require (encrypted). verify-full also checks the certificate; a database with a private certificate (Amazon RDS among them) needs require`,
      },
      example: { host: "db.customer.com", port: 5432, database: "plant", ssl: "require", user: { $secret: "username" }, password: { $secret: "password" } },
    },
    address: {
      fields: {
        query: `required: one SELECT (or VALUES) query, at most ${MAX_QUERY} characters. It runs read-only. $1 is the cursor: the last row's cursor_column value, else cursor_start, else NULL, so the first poll needs a query that accepts NULL`,
        timestamp_column: "optional: the column with each row's time; each row then becomes one reading at that time. Without it the query must return exactly one row, read at the poll time",
        cursor_column: "optional, needs timestamp_column: read only rows after the last one seen (order the query by this column and leave out rows where it is NULL)",
        cursor_start: "optional: the first cursor value (text or number)",
        max_rows: `optional whole number 1-${MAX_ROWS}, default 1000 rows per poll; a backlog is caught up over several polls`,
      },
      example: { query: "SELECT id, ts, kwh FROM energy WHERE $1::bigint IS NULL OR id > $1 ORDER BY id", timestamp_column: "ts", cursor_column: "id" },
    },
    source: {
      fields: { column: "required: the query column with this metric's value (numbers, numeric text or true/false)" },
      example: { column: "kwh" },
    },
    map: { metricId: "7", source: { column: "kwh" }, scale: 1, valueOffset: 0, isEnabled: true },
  },
};

export const MAP_FIELDS = {
  metricId: "required: the Zira metric of the data source this value is saved to (a writable, not calculated, metric of the data source)",
  source: "required: where the value is read, in the protocol's source format",
  scale: "optional number, default 1, not 0: the saved value is raw × scale + valueOffset",
  valueOffset: "optional number, default 0",
  isEnabled: "optional true/false, default true: a disabled map is not read",
};

export const SECRET_STEPS = [
  "Never ask for, accept, type or store a database user name or password in chat or in a command. The connection only holds references such as { \"$secret\": \"password\" }.",
  "1. Create the gateway disabled (create-gateway; a postgres gateway is always created disabled).",
  `2. Run secret-steps for it: it gives the exact AWS Parameter Store name ${parameterName("<companyId>", "<endpointId>")} and the keys the connection refers to. Pass them to a Zira admin with AWS access.`,
  "3. The admin creates that SecureString parameter (default aws/ssm key) holding one JSON object such as {\"username\": \"...\", \"password\": \"...\"}, with a database user that can only read what the queries need. The values never pass through this chat.",
  "4. Wait until the admin confirms it exists. Then create the binding and its maps, run a test read, and enable the binding and the gateway.",
];

// publicBuild: the public plugin connects Modbus TCP meters only; databases stay with Zira staff builds.
export function formats(protocol, { publicBuild = false } = {}) {
  if (protocol !== undefined) protocolOf(protocol);
  const names = protocol ? [protocol] : Object.keys(PROTOCOLS).filter(name => !publicBuild || name === PUBLIC_PROTOCOL);
  return {
    kind: "collection-formats",
    protocols: Object.fromEntries(names.map(name => {
      const p = PROTOCOLS[name];
      return [name, { title: p.title, connection: p.connection, address: p.address, source: p.source, mapExample: p.map,
        ...(p.secretFields.length ? { secretFields: p.secretFields, secretSteps: SECRET_STEPS } : {}) }];
    })),
    map: MAP_FIELDS,
    gateway: {
      pollIntervalS: "seconds between polls, 60-3600, default 60",
      timeoutMs: publicBuild ? "per request, 100-60000 ms, default 3000" : "per request (Modbus) or connect/query (PostgreSQL), 100-60000 ms, default 3000",
      retries: publicBuild ? "retries per request, 0-5, default 2" : "Modbus retries per request, 0-5, default 2 (PostgreSQL does not retry: the next poll is the retry)",
    },
    notes: [
      "Keys are snake_case inside connection, address and source (unit_id, word_order), exactly as shown.",
      "One binding per data source; the gateway and the data source must be at the same site.",
      "New bindings are created disabled. Test read, then enable.",
      "The collector refuses hosts inside Zira's own network.",
      PRIVATE_HOST_NOTE,
    ],
  };
}

// The one protocol the public plugin sets up.
export const PUBLIC_PROTOCOL = "modbus_tcp";

// A private IPv4 address (10/8, 172.16/12, 192.168/16, 100.64/10) is only reachable through a site network (VPN).
export function privateHost(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host ?? "").trim());
  if (!m || m.slice(1).some(n => Number(n) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export const PRIVATE_HOST_NOTE = "A gateway at a private address (10.x, 172.16-31.x, 192.168.x) is read through the site's network (VPN). " +
  "The network is requested and chosen in Zira; when one is needed, the result carries a networkStep with the link and what to do there.";

export function protocolOf(value) {
  if (!Object.hasOwn(PROTOCOLS, value ?? "")) throw invalid(`Unknown protocol "${value ?? ""}". Use ${Object.keys(PROTOCOLS).join(" or ")}.`);
  return PROTOCOLS[value];
}

// Refuses a secret given as a plain value. The message never repeats the value.
function refusePlainSecrets(protocol, connection) {
  const plain = [];
  for (const field of PROTOCOLS[protocol].secretFields)
    if (connection[field] !== undefined && connection[field] !== null && !secretRefKey(connection[field])) plain.push(`connection.${field}`);
  const walk = (value, path) => {
    if (!object(value) || secretRefKey(value)) return;
    for (const [k, v] of Object.entries(value)) {
      const here = `${path}.${k}`;
      if (SECRET_NAME.test(k) && v !== null && v !== undefined && !secretRefKey(v) && !plain.includes(here)) plain.push(here);
      walk(v, here);
    }
  };
  walk(connection, "connection");
  if (plain.length)
    throw invalid(`${plain.join(" and ")} must be a secret reference such as { "$secret": "password" }, never the value itself. ` +
      "A user name or password must never be typed in chat or in a command: a Zira admin stores it in AWS (see secret-steps). Nothing was sent.");
}

export function checkConnection(protocol, connection) {
  protocolOf(protocol);
  if (!object(connection)) throw invalid("connection must be a JSON object");
  refusePlainSecrets(protocol, connection);
  if (protocol === "modbus_tcp") {
    onlyKeys(connection, ["host", "port"], "connection");
    if (!nonBlank(connection.host)) throw invalid("connection.host is required");
    if (connection.port !== undefined && !intIn(connection.port, 1, 65535)) throw invalid("connection.port must be a whole number between 1 and 65535");
    return connection;
  }
  onlyKeys(connection, ["host", "port", "database", "user", "password", "ssl"], "connection");
  if (!nonBlank(connection.host)) throw invalid("connection.host is required");
  if (connection.port !== undefined && connection.port !== null && !intIn(connection.port, 1, 65535)) throw invalid("connection.port must be a whole number between 1 and 65535");
  if (!nonBlank(connection.database)) throw invalid("connection.database is required");
  if (!secretRefKey(connection.user) || !secretRefKey(connection.password))
    throw invalid('connection.user and connection.password are required, as secret references { "$secret": "username" } and { "$secret": "password" }');
  if (connection.ssl !== undefined && connection.ssl !== null && !SSL.includes(connection.ssl)) throw invalid(`connection.ssl must be one of ${SSL.join(", ")}`);
  return connection;
}

export function checkAddress(protocol, address) {
  protocolOf(protocol);
  if (!object(address)) throw invalid("address must be a JSON object");
  if (protocol === "modbus_tcp") {
    onlyKeys(address, ["unit_id"], "address");
    if (!intIn(address.unit_id, 0, 255)) throw invalid("address.unit_id must be a whole number between 0 and 255");
    return address;
  }
  onlyKeys(address, ["query", "timestamp_column", "cursor_column", "cursor_start", "max_rows"], "address");
  if (!nonBlank(address.query)) throw invalid("address.query is required");
  if (address.query.trim().length > MAX_QUERY) throw invalid(`address.query is longer than ${MAX_QUERY} characters`);
  const column = key => {
    const v = address[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (!nonBlank(v)) throw invalid(`address.${key} must be a column name`);
    return v;
  };
  const ts = column("timestamp_column"), cursor = column("cursor_column");
  if (cursor && !ts) throw invalid("address.timestamp_column is required with cursor_column: each new row is a reading at its own time");
  const start = address.cursor_start;
  if (start !== undefined && start !== null && typeof start !== "string" && !(typeof start === "number" && Number.isFinite(start)))
    throw invalid("address.cursor_start must be a string or a number");
  if (address.max_rows !== undefined && address.max_rows !== null && !intIn(address.max_rows, 1, MAX_ROWS))
    throw invalid(`address.max_rows must be a whole number between 1 and ${MAX_ROWS}`);
  return address;
}

export function checkSource(protocol, source, where = "source") {
  protocolOf(protocol);
  if (!object(source)) throw invalid(`${where} must be a JSON object`);
  if (protocol === "modbus_tcp") {
    onlyKeys(source, ["table", "register", "type", "word_order", "byte_order", "bit"], where);
    if (!TABLES.includes(source.table)) throw invalid(`${where}.table must be one of ${TABLES.join(", ")}`);
    if (!TYPES.includes(source.type)) throw invalid(`${where}.type must be one of ${TYPES.join(", ")}`);
    if (!intIn(source.register, 0, 65535)) throw invalid(`${where}.register must be a whole number between 0 and 65535`);
    for (const key of ["word_order", "byte_order"])
      if (source[key] !== undefined && source[key] !== null && !ORDERS.includes(source[key])) throw invalid(`${where}.${key} must be big or little`);
    const bitTable = source.table === "coil" || source.table === "discrete";
    const count = bitTable ? 1 : REGISTERS[source.type];
    if (source.bit !== undefined && source.bit !== null) {
      if (!intIn(source.bit, 0, 15)) throw invalid(`${where}.bit must be a whole number between 0 and 15`);
      if (!bitTable && count > 1) throw invalid(`${where}.bit applies to a 16-bit register; type ${source.type} spans ${count} registers`);
    }
    if (source.register + count - 1 > 65535) throw invalid(`${where}.register ${source.register} + ${count} registers runs past 65535`);
    return source;
  }
  onlyKeys(source, ["column"], where);
  if (!nonBlank(source.column)) throw invalid(`${where}.column is required`);
  return source;
}

// Keys a binding or profile read returns that are not sent back (copied maps work as they are).
const READ_ONLY_MAP_KEYS = ["id", "metricKey", "metricName", "auditInfo"];
const MAP_KEYS = ["metricId", "source", "scale", "valueOffset", "isEnabled"];
export const MAX_MAPS = 500;
const metricIdOf = v => (typeof v === "number" && Number.isInteger(v) && v > 0) || (typeof v === "string" && /^[1-9]\d{0,9}$/.test(v)) ? String(v) : null;

// Maps as the metric-maps PUT and the test read take them: [{ metricId, source, scale, valueOffset, isEnabled }].
export function checkMaps(protocol, maps) {
  protocolOf(protocol);
  if (!Array.isArray(maps) || !maps.length) throw invalid("maps must be a JSON array with at least one map");
  if (maps.length > MAX_MAPS) throw invalid(`maps can have at most ${MAX_MAPS} entries`);
  const seen = new Set();
  return maps.map((m, i) => {
    const where = `maps[${i}]`;
    if (!object(m)) throw invalid(`${where} must be a JSON object`);
    onlyKeys(m, [...MAP_KEYS, ...READ_ONLY_MAP_KEYS], where);
    const metricId = metricIdOf(m.metricId);
    if (!metricId) throw invalid(`${where}.metricId must be a metric ID`);
    if (seen.has(metricId)) throw invalid(`${where}: metric ${metricId} is mapped twice; a metric is mapped once`);
    seen.add(metricId);
    checkSource(protocol, m.source, `${where}.source`);
    const out = { metricId, source: m.source };
    if (m.scale !== undefined && m.scale !== null) {
      if (typeof m.scale !== "number" || !Number.isFinite(m.scale) || m.scale === 0) throw invalid(`${where}.scale must be a number other than 0`);
      out.scale = m.scale;
    }
    if (m.valueOffset !== undefined && m.valueOffset !== null) {
      if (typeof m.valueOffset !== "number" || !Number.isFinite(m.valueOffset)) throw invalid(`${where}.valueOffset must be a number`);
      out.valueOffset = m.valueOffset;
    }
    if (m.isEnabled !== undefined && m.isEnabled !== null) {
      if (typeof m.isEnabled !== "boolean") throw invalid(`${where}.isEnabled must be true or false`);
      out.isEnabled = m.isEnabled;
    }
    return out;
  });
}

// A connection as shown to people: any non-reference value under a secret-like name is hidden.
export function safeConnection(connection) {
  if (Array.isArray(connection)) return connection.map(safeConnection);
  if (!object(connection) || secretRefKey(connection)) return connection;
  return Object.fromEntries(Object.entries(connection).map(([k, v]) =>
    [k, SECRET_NAME.test(k) && v !== null && v !== undefined && !secretRefKey(v) ? "<hidden>" : safeConnection(v)]));
}

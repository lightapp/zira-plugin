// Dependency-free AWS IoT Core client for the Zira plugin: Cognito Identity credentials,
// a SigV4-presigned MQTT-over-WebSocket URL, a minimal RFC 6455 client and MQTT 5 framing.
// It speaks only what Zira's remote-control topics need: QoS 0/1 publish and subscribe.
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";

export const MAX_PACKET = 256 * 1024;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const POOL = /^[a-z]{2}(-[a-z]+)+-\d:[0-9a-f-]{36}$/;
const USER_POOL = /^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/;
const ENDPOINT = /^[a-z0-9]+(-ats)?\.iot\.[a-z]{2}(-[a-z]+)+-\d\.amazonaws\.com$/;

export class IotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

// The platform's /prod-vision/iot-client-creds answer, checked before any AWS call.
export function iotConfig(raw) {
  const c = raw?.data ?? raw ?? {};
  const region = String(c.region ?? ""), endpoint = String(c.iotEndpoint ?? "");
  if (!REGION.test(region) || !ENDPOINT.test(endpoint) || !endpoint.endsWith(`.${region}.amazonaws.com`) ||
      !POOL.test(String(c.identityPoolId ?? "")) || !USER_POOL.test(String(c.userPoolId ?? "")) ||
      !String(c.identityPoolId).startsWith(`${region}:`))
    throw new IotError("bad_config", "Zira returned an unexpected IoT configuration");
  return { region, endpoint, identityPoolId: c.identityPoolId, userPoolId: c.userPoolId,
    ...(typeof c.clientAccess === "string" ? { clientAccess: c.clientAccess } : {}) };
}

async function cognito(region, target, body, fetchImpl) {
  const response = await fetchImpl(`https://cognito-identity.${region}.amazonaws.com/`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityService.${target}` },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (raw.length > 64 * 1024) throw new IotError("cognito", "Cognito response too large");
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch { /* reported below */ }
  if (!response.ok) {
    const type = String(json.__type ?? "").split("#").pop();
    // NotAuthorized/ResourceNotFound mean this sign-in is not accepted by the identity pool.
    throw new IotError(/NotAuthorized|ResourceNotFound|InvalidIdentityPoolConfiguration/.test(type) ? "not_authorized" : "cognito",
      `Cognito ${target} failed (${type || response.status})`, { status: response.status });
  }
  return json;
}

// Exchanges the Zira ID token for short-lived AWS credentials of the identity pool's mapped role.
export async function identityCredentials(config, idToken, { fetchImpl = globalThis.fetch } = {}) {
  const logins = { [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: idToken };
  const { IdentityId } = await cognito(config.region, "GetId", { IdentityPoolId: config.identityPoolId, Logins: logins }, fetchImpl);
  if (!POOL.test(String(IdentityId ?? ""))) throw new IotError("cognito", "Cognito returned no identity");
  const { Credentials: c } = await cognito(config.region, "GetCredentialsForIdentity", { IdentityId, Logins: logins }, fetchImpl);
  if (!c?.AccessKeyId || !c?.SecretKey || !c?.SessionToken) throw new IotError("cognito", "Cognito returned no credentials");
  return { identityId: IdentityId, accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken,
    expiresAt: Number.isFinite(c.Expiration) ? new Date(c.Expiration * 1000).toISOString() : null };
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const rfc3986 = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

// AWS IoT's SigV4 query signing for MQTT over WebSocket; the session token is appended after signing.
export function presignIotUrl({ endpoint, region, credentials, now = new Date() }) {
  if (!ENDPOINT.test(endpoint) || !REGION.test(region)) throw new IotError("bad_config", "Invalid IoT endpoint");
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/iotdevicegateway/aws4_request`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-SignedHeaders", "host"],
  ].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join("&");
  const canonical = ["GET", "/mqtt", query, `host:${endpoint}\n`, "host", sha256("")].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, "iotdevicegateway", "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const token = credentials.sessionToken ? `&X-Amz-Security-Token=${rfc3986(credentials.sessionToken)}` : "";
  return `wss://${endpoint}/mqtt?${query}&X-Amz-Signature=${signature}${token}`;
}

// ---- RFC 6455 client: binary frames only, masked as a client must ----

export function encodeFrame(opcode, payload = Buffer.alloc(0), mask = randomBytes(4)) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// Parses complete frames from the front of buf; returns frames and the bytes consumed.
export function decodeFrames(buf, max = MAX_PACKET * 2) {
  const frames = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const b0 = buf[at], b1 = buf[at + 1];
    let len = b1 & 127, off = at + 2;
    if (len === 126) { if (buf.length - off < 2) break; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (buf.length - off < 8) break; const big = buf.readBigUInt64BE(off); if (big > BigInt(max)) throw new IotError("protocol", "WebSocket frame too large"); len = Number(big); off += 8; }
    if (len > max) throw new IotError("protocol", "WebSocket frame too large");
    const masked = (b1 & 128) !== 0, maskAt = off;
    if (masked) off += 4;
    if (buf.length - off < len) break;
    let payload = buf.subarray(off, off + len);
    if (masked) { payload = Buffer.from(payload); for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)]; }
    frames.push({ fin: (b0 & 128) !== 0, opcode: b0 & 15, payload });
    at = off + len;
  }
  return { frames, used: at };
}

// Opens a WebSocket (wss over TLS, or ws for loopback tests) with the "mqtt" subprotocol.
export function openWebSocket(url, { timeoutMs = 15000, protocol = "mqtt" } = {}) {
  const u = new URL(url);
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)))
    throw new IotError("bad_config", "WebSocket URL must be wss:// (ws:// only on loopback)");
  const key = randomBytes(16).toString("base64");
  const port = Number(u.port || (u.protocol === "wss:" ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const socket = u.protocol === "wss:" ? tls.connect({ host, port, servername: host, ALPNProtocols: ["http/1.1"] }) : net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new IotError("timeout", "Timed out connecting to AWS IoT")); }, timeoutMs);
    let head = Buffer.alloc(0);
    const fail = error => { clearTimeout(timer); socket.destroy(); reject(error instanceof IotError ? error : new IotError("network", `Could not reach AWS IoT (${error.code ?? error.message})`)); };
    socket.once("error", fail);
    socket.once(u.protocol === "wss:" ? "secureConnect" : "connect", () => {
      socket.write([`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", `Sec-WebSocket-Protocol: ${protocol}`, "", ""].join("\r\n"));
    });
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 16384) fail(new IotError("protocol", "Oversized WebSocket handshake")); return; }
      socket.off("data", onData);
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(lines[0].split(" ")[1]);
      const headers = Object.fromEntries(lines.slice(1).map(l => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      // 403 at the upgrade means the signed credentials were refused.
      if (status !== 101) return fail(new IotError(status === 403 ? "not_authorized" : "protocol", `AWS IoT refused the WebSocket (HTTP ${status})`, { status }));
      if (headers["sec-websocket-accept"] !== accept) return fail(new IotError("protocol", "Invalid WebSocket accept key"));
      clearTimeout(timer);
      socket.off("error", fail);
      resolve(new WebSocketStream(socket, head.subarray(end + 4)));
    };
    socket.on("data", onData);
  });
}

class WebSocketStream extends EventEmitter {
  constructor(socket, rest) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.closed = false;
    this.held = [rest];
    socket.on("data", chunk => this.held ? this.held.push(chunk) : this.feed(chunk));
    socket.on("error", error => this.emit("error", new IotError("network", `AWS IoT connection error (${error.code ?? error.message})`)));
    socket.on("close", () => { this.closed = true; this.emit("close"); });
  }
  // Bytes that arrive before the reader attaches are held, then fed in order.
  start() {
    const held = this.held;
    this.held = null;
    for (const chunk of held) if (chunk.length) this.feed(chunk);
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let parsed;
    try { parsed = decodeFrames(this.buf); } catch (error) { this.emit("error", error); this.socket.destroy(); return; }
    this.buf = this.buf.subarray(parsed.used);
    for (const f of parsed.frames) {
      if (f.opcode === 9) this.socket.write(encodeFrame(10, f.payload));
      else if (f.opcode === 8) { if (!this.closed) this.socket.end(encodeFrame(8, f.payload.subarray(0, 2))); }
      else if (f.opcode === 2 || f.opcode === 0) {
        this.parts.push(f.payload);
        if (f.fin) { this.emit("data", Buffer.concat(this.parts)); this.parts = []; }
      }
    }
  }
  send(data) { if (!this.closed) this.socket.write(encodeFrame(2, data)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(encodeFrame(8, Buffer.from([0x03, 0xe8]))); } catch { /* already gone */ }
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}

// ---- MQTT 5 framing ----

export const PACKET = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

export function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
}

export function readVarint(buf, at) {
  let value = 0, mult = 1, i = at;
  for (let n = 0; n < 4; n++) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    value += (b & 127) * mult;
    if (!(b & 128)) return { value, next: i };
    mult *= 128;
  }
  throw new IotError("protocol", "Malformed MQTT length");
}

const str = value => { const b = Buffer.from(String(value), "utf8"); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const packet = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags]), varint(body.length), body]);
const props = parts => { const body = Buffer.concat(parts); return Buffer.concat([varint(body.length), body]); };

export function encodeConnect({ clientId, keepAlive = 60 }) {
  return packet(PACKET.CONNECT, 0, Buffer.concat([str("MQTT"), Buffer.from([5, 0x02]), u16(keepAlive), props([]), str(clientId)]));
}

export function encodeSubscribe(packetId, filters, qos = 1) {
  return packet(PACKET.SUBSCRIBE, 2, Buffer.concat([u16(packetId), props([]), ...filters.flatMap(f => [str(f), Buffer.from([qos & 3])])]));
}

export function encodePublish({ topic, payload, qos = 0, retain = false, packetId, messageExpiry, contentType }) {
  const p = [];
  if (Number.isInteger(messageExpiry) && messageExpiry > 0) p.push(Buffer.from([0x02]), u32(messageExpiry));
  if (contentType) p.push(Buffer.from([0x03]), str(contentType));
  return packet(PACKET.PUBLISH, (qos << 1) | (retain ? 1 : 0),
    Buffer.concat([str(topic), qos > 0 ? u16(packetId) : Buffer.alloc(0), props(p), Buffer.from(payload)]));
}

export const encodePuback = packetId => packet(PACKET.PUBACK, 0, u16(packetId));
export const PINGREQ = Buffer.from([0xc0, 0x00]);
export const DISCONNECT = Buffer.from([0xe0, 0x00]);

// Property id → value width; enough to skip or read every MQTT 5 property.
const PROP_KIND = { 0x01: 1, 0x02: 4, 0x03: "s", 0x08: "s", 0x09: "b", 0x0b: "v", 0x11: 4, 0x12: "s", 0x13: 2, 0x15: "s", 0x16: "b",
  0x17: 1, 0x18: 4, 0x19: 1, 0x1a: "s", 0x1c: "s", 0x1f: "s", 0x21: 2, 0x22: 2, 0x23: 2, 0x24: 1, 0x25: 1, 0x26: "p", 0x27: 4,
  0x28: 1, 0x29: 1, 0x2a: 1 };
const PROP_NAME = { 0x02: "messageExpiry", 0x03: "contentType", 0x13: "serverKeepAlive", 0x1f: "reasonString", 0x21: "receiveMaximum", 0x27: "maximumPacketSize" };

export function readProps(buf, at) {
  const len = readVarint(buf, at);
  if (!len) throw new IotError("protocol", "Truncated MQTT properties");
  const end = len.next + len.value, out = {};
  let i = len.next;
  const s = () => { const l = buf.readUInt16BE(i); const v = buf.subarray(i + 2, i + 2 + l); i += 2 + l; return v; };
  while (i < end) {
    const idByte = buf[i++], kind = PROP_KIND[idByte];
    let value;
    if (kind === 1) value = buf[i++];
    else if (kind === 2) { value = buf.readUInt16BE(i); i += 2; }
    else if (kind === 4) { value = buf.readUInt32BE(i); i += 4; }
    else if (kind === "s") value = s().toString("utf8");
    else if (kind === "b") value = s();
    else if (kind === "v") { const v = readVarint(buf, i); value = v.value; i = v.next; }
    else if (kind === "p") { s(); s(); continue; }
    else throw new IotError("protocol", `Unknown MQTT property 0x${idByte.toString(16)}`);
    if (PROP_NAME[idByte]) out[PROP_NAME[idByte]] = value;
  }
  if (i !== end) throw new IotError("protocol", "Malformed MQTT properties");
  return { props: out, next: end };
}

// Splits a byte stream into MQTT packets; returns parsed packets and the bytes consumed.
export function decodePackets(buf, max = MAX_PACKET) {
  const out = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const len = readVarint(buf, at + 1);
    if (!len) break;
    if (len.value > max) throw new IotError("protocol", "MQTT packet too large");
    if (buf.length < len.next + len.value) break;
    out.push(parsePacket(buf[at] >> 4, buf[at] & 15, buf.subarray(len.next, len.next + len.value)));
    at = len.next + len.value;
  }
  return { packets: out, used: at };
}

function parsePacket(type, flags, body) {
  if (type === PACKET.CONNACK) {
    const p = body.length > 2 ? readProps(body, 2).props : {};
    return { type, sessionPresent: !!(body[0] & 1), reasonCode: body[1], props: p };
  }
  if (type === PACKET.PUBLISH) {
    const qos = (flags >> 1) & 3, tl = body.readUInt16BE(0);
    let i = 2 + tl;
    const topic = body.subarray(2, i).toString("utf8");
    let packetId;
    if (qos > 0) { packetId = body.readUInt16BE(i); i += 2; }
    const { props: p, next } = readProps(body, i);
    return { type, topic, qos, retain: !!(flags & 1), packetId, props: p, payload: body.subarray(next) };
  }
  if (type === PACKET.PUBACK) return { type, packetId: body.readUInt16BE(0), reasonCode: body.length > 2 ? body[2] : 0 };
  if (type === PACKET.SUBACK) {
    const { next } = readProps(body, 2);
    return { type, packetId: body.readUInt16BE(0), reasonCodes: [...body.subarray(next)] };
  }
  if (type === PACKET.DISCONNECT) return { type, reasonCode: body.length ? body[0] : 0, props: body.length > 1 ? readProps(body, 1).props : {} };
  return { type };
}

const REASONS = { 0x80: "unspecified error", 0x83: "implementation specific error", 0x87: "not authorized", 0x8f: "topic filter invalid",
  0x90: "topic name invalid", 0x91: "packet identifier in use", 0x97: "quota exceeded", 0x99: "payload format invalid",
  0x86: "bad user name or password", 0x88: "server unavailable", 0x8a: "banned", 0x8e: "session taken over", 0x9c: "use another server" };
export const reasonText = code => REASONS[code] ?? `reason 0x${Number(code).toString(16)}`;

export const parseJson = payload => {
  if (!payload?.length) return null;
  try { return JSON.parse(payload.toString("utf8")); } catch { return null; }
};

// One MQTT 5 session over a WebSocket. Messages are emitted as { topic, retain, qos, json, payload, receivedAt }.
export class MqttClient extends EventEmitter {
  static async connect({ url, clientId, keepAlive = 60, timeoutMs = 15000, open = openWebSocket }) {
    if (!/^[A-Za-z0-9:_.-]{1,128}$/.test(clientId)) throw new IotError("bad_config", "Invalid MQTT client ID");
    const ws = await open(url, { timeoutMs });
    const client = new MqttClient(ws, keepAlive);
    await client.handshake(clientId, timeoutMs);
    return client;
  }
  constructor(ws, keepAlive) {
    super();
    this.ws = ws;
    this.keepAlive = keepAlive;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.waiting = new Map();
    this.closed = false;
    ws.on("data", chunk => this.feed(chunk));
    ws.on("error", error => this.fail(error));
    ws.on("close", () => this.fail(new IotError("closed", this.disconnectReason ?? "AWS IoT closed the connection")));
    ws.start?.();
  }
  handshake(clientId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new IotError("timeout", "AWS IoT did not accept the MQTT connection in time")), timeoutMs);
      this.waiting.set("connack", { resolve: p => {
        clearTimeout(timer);
        if (p.reasonCode !== 0) return reject(new IotError(p.reasonCode === 0x87 || p.reasonCode === 0x86 ? "not_authorized" : "refused", `AWS IoT refused the connection: ${reasonText(p.reasonCode)}`));
        const seconds = p.props.serverKeepAlive ?? this.keepAlive;
        this.ping = setInterval(() => this.ws.send(PINGREQ), Math.max(5, seconds * 0.75) * 1000);
        this.ping.unref?.();
        resolve();
      }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(encodeConnect({ clientId, keepAlive: this.keepAlive }));
    });
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let parsed;
    try { parsed = decodePackets(this.buf); } catch (error) { this.fail(error); return; }
    this.buf = this.buf.subarray(parsed.used);
    for (const p of parsed.packets) this.handle(p);
  }
  handle(p) {
    if (p.type === PACKET.CONNACK) this.settle("connack", p);
    else if (p.type === PACKET.SUBACK || p.type === PACKET.PUBACK) this.settle(p.packetId, p);
    else if (p.type === PACKET.PUBLISH) {
      if (p.qos === 1) this.ws.send(encodePuback(p.packetId));
      this.emit("message", { topic: p.topic, retain: p.retain, qos: p.qos, payload: p.payload, json: parseJson(p.payload),
        messageExpiry: p.props.messageExpiry, receivedAt: Date.now() });
    } else if (p.type === PACKET.DISCONNECT) {
      this.disconnectReason = `AWS IoT disconnected: ${reasonText(p.reasonCode)}`;
      this.disconnectCode = p.reasonCode;
    }
  }
  settle(key, p) {
    const w = this.waiting.get(key);
    if (w) { this.waiting.delete(key); w.resolve(p); }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    if (this.disconnectCode === 0x87) error = new IotError("not_authorized", this.disconnectReason);
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
    this.emit("close", error);
  }
  request(build, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new IotError("closed", "The AWS IoT connection is closed"));
    const packetId = this.nextId;
    this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(packetId); reject(new IotError("timeout", "AWS IoT did not acknowledge in time")); }, timeoutMs);
      this.waiting.set(packetId, { resolve: p => { clearTimeout(timer); resolve(p); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(build(packetId));
    });
  }
  // AWS IoT permits at most eight filters per SUBSCRIBE, regardless of its connection limit.
  // Stop on the first refused batch; never retry a refusal or report partial success.
  async subscribe(filters, { qos = 1 } = {}) {
    const reasonCodes = [];
    for (let offset = 0; offset < filters.length; offset += 8) {
      const batch = filters.slice(offset, offset + 8);
      const ack = await this.request(id => encodeSubscribe(id, batch, qos));
      if (ack.type !== PACKET.SUBACK || ack.reasonCodes?.length !== batch.length)
        throw new IotError("protocol", "AWS IoT returned an invalid subscription acknowledgement");
      const refused = ack.reasonCodes.map((code, i) => [batch[i], code]).filter(([, code]) => code >= 0x80);
      if (refused.length)
        throw new IotError(refused.some(([, c]) => c === 0x87) ? "not_authorized" : "refused",
          `AWS IoT refused the subscription to ${refused.map(([f, c]) => `${f} (${reasonText(c)})`).join(", ")}`);
      reasonCodes.push(...ack.reasonCodes);
    }
    return reasonCodes;
  }
  async publish(topic, payload, { qos = 1, retain = false, messageExpiry, contentType = "application/json" } = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
    if (body.length > 128 * 1024) throw new IotError("bad_request", "MQTT payload exceeds 128 KiB");
    if (qos === 0) { this.ws.send(encodePublish({ topic, payload: body, qos: 0, retain, messageExpiry, contentType })); return { reasonCode: 0 }; }
    const ack = await this.request(packetId => encodePublish({ topic, payload: body, qos: 1, retain, packetId, messageExpiry, contentType }));
    if (ack.reasonCode >= 0x80)
      throw new IotError(ack.reasonCode === 0x87 ? "not_authorized" : "refused", `AWS IoT refused the publish to ${topic}: ${reasonText(ack.reasonCode)}`);
    return { reasonCode: ack.reasonCode };
  }
  close() {
    if (this.closed) return;
    try { this.ws.send(DISCONNECT); } catch { /* already gone */ }
    this.fail(new IotError("closed", "Closed"));
    this.ws.close();
  }
}

// MQTT topic filter matching with + and # wildcards.
export function topicMatches(filter, topic) {
  const f = filter.split("/"), t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

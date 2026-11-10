// Signaling + mobile page host. Deploy on Render (HTTPS is required for phone camera access).
const http = require("http"),
  fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { WebSocketServer } = require("ws");

function getIceServers() {
  if (!process.env.ICE_SERVERS)
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ];
  let servers;
  try {
    servers = JSON.parse(process.env.ICE_SERVERS);
  } catch {
    throw new Error("ICE_SERVERS must be valid JSON");
  }
  if (
    !Array.isArray(servers) ||
    !servers.length ||
    servers.some(
      (server) =>
        !server ||
        typeof server !== "object" ||
        !(
          typeof server.urls === "string" ||
          (Array.isArray(server.urls) &&
            server.urls.length > 0 &&
            server.urls.every((url) => typeof url === "string"))
        ) ||
        (server.username !== undefined &&
          typeof server.username !== "string") ||
        (server.credential !== undefined &&
          typeof server.credential !== "string"),
    )
  )
    throw new Error("ICE_SERVERS must be a non-empty array of valid ICE servers");
  if (
    !process.env.TURN_SECRET &&
    servers.some(
      (server) =>
        server.username !== undefined || server.credential !== undefined,
    )
  )
    throw new Error("TURN_SECRET is required for credentialed ICE_SERVERS");
  return servers;
}

const iceServers = getIceServers();
const turnSecret = process.env.TURN_SECRET;
const publicOrigin = new URL(
  process.env.PUBLIC_ORIGIN || "https://cam-share-app.onrender.com",
).origin;
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || `${publicOrigin},file://`)
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, "")),
);
const maxConnections = Number(process.env.MAX_CONNECTIONS || 200);
const maxRooms = Number(process.env.MAX_ROOMS || 100);
const joinWindowMs = 60_000;
const maxJoinsPerWindow = 10;
const joinAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of joinAttempts) {
    const recent = timestamps.filter((timestamp) => now - timestamp < joinWindowMs);
    if (recent.length) joinAttempts.set(ip, recent);
    else joinAttempts.delete(ip);
  }
}, joinWindowMs).unref();
const landingPage = fs.readFileSync(
  path.join(__dirname, "public", "index.html"),
);
const cameraPage = fs.readFileSync(path.join(__dirname, "public", "m.html"));

function requestIp(req) {
  if (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-for"])
    return req.headers["x-forwarded-for"].split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (joinAttempts.get(ip) || []).filter(
    (timestamp) => now - timestamp < joinWindowMs,
  );
  if (recent.length >= maxJoinsPerWindow) {
    joinAttempts.set(ip, recent);
    return true;
  }
  recent.push(now);
  joinAttempts.set(ip, recent);
  return false;
}

function getClientIceServers() {
  if (!turnSecret) return iceServers;
  const expiry = Math.floor(Date.now() / 1000) + 10 * 60;
  const username = `${expiry}:${process.env.TURN_USERNAME || "camshare"}:${crypto
    .randomBytes(8)
    .toString("hex")}`;
  const credential = crypto
    .createHmac("sha1", turnSecret)
    .update(username)
    .digest("base64");
  return iceServers.map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (!urls.some((url) => /^turns?:/i.test(url))) return server;
    return { ...server, username, credential };
  });
}

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://${new URL(publicOrigin).host} wss://${new URL(publicOrigin).host}`,
  );
  const url = new URL(req.url, publicOrigin);
  if (url.pathname !== "/") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (url.searchParams.has("s")) {
    if (!/^[a-f0-9]{32}$/.test(url.searchParams.get("s"))) {
      res.writeHead(400);
      res.end("Invalid camera room");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(cameraPage);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(landingPage);
});
server.on("error", (error) =>
  console.error("HTTP server error:", error.message),
);
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }, done) => {
    if (!origin || !allowedOrigins.has(origin.replace(/\/$/, ""))) {
      done(false, 403, "Origin not allowed");
      return;
    }
    if (wss.clients.size >= maxConnections) {
      done(false, 503, "Connection limit reached");
      return;
    }
    done(true);
  },
});
const rooms = new Map();
wss.on("error", (error) =>
  console.error("WebSocket server error:", error.message),
);
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
server.on("close", () => clearInterval(heartbeat));
const others = (ws) =>
  [...(rooms.get(ws.room) || [])].filter((c) => c !== ws && c.readyState === 1);
function removeFromRoom(ws) {
  if (!ws.room) return;
  others(ws).forEach((client) =>
    client.send(JSON.stringify({ t: "peer", up: false, role: ws.role })),
  );
  const room = rooms.get(ws.room);
  if (room) {
    room.delete(ws);
    if (!room.size) rooms.delete(ws.room);
  }
  ws.room = null;
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.clientIp = requestIp(req);
  ws.on("error", (error) =>
    console.error("WebSocket client error:", error.message),
  );
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      ws.close(1008, "Invalid message");
      return;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      ws.close(1008, "Invalid message");
      return;
    }
    if (m.t === "join") {
      if (
        ws.room ||
        rateLimited(ws.clientIp) ||
        typeof m.room !== "string" ||
        !/^[a-f0-9]{32}$/.test(m.room) ||
        !["desktop", "phone"].includes(m.role)
      ) {
        ws.close(1008, "Invalid room, role, or join rate");
        return;
      }
      const members = rooms.get(m.room);
      const previous =
        members && [...members].find((member) => member.role === m.role);
      if (!previous && !members && rooms.size >= maxRooms) {
        ws.close(1013, "Room limit reached");
        return;
      }
      if (previous) {
        removeFromRoom(previous);
        previous.close(4001, "Replaced by reconnect");
      }
      const room = rooms.get(m.room) || new Set();
      ws.room = m.room;
      ws.role = m.role;
      if (!rooms.has(ws.room)) rooms.set(ws.room, room);
      room.add(ws);
      ws.send(JSON.stringify({ t: "config", iceServers: getClientIceServers() }));
      others(ws).forEach((client) => {
        client.send(JSON.stringify({ t: "peer", up: true, role: ws.role }));
        ws.send(JSON.stringify({ t: "peer", up: true, role: client.role }));
      });
    } else if (
      m.t === "sig" &&
      ws.room &&
      m.data &&
      typeof m.data === "object" &&
      !Array.isArray(m.data)
    ) {
      others(ws).forEach((client) =>
        client.send(JSON.stringify({ t: "sig", data: m.data })),
      );
    }
  });
  ws.on("close", () => removeFromRoom(ws));
});
server.listen(process.env.PORT || 8080, () =>
  console.log("CamShare server up"),
);

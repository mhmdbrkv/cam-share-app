// Signaling + mobile page host. Deploy on Render (HTTPS is required for phone camera access).
const http = require("http"),
  fs = require("fs"),
  path = require("path");
const { WebSocketServer } = require("ws");
function getIceServers() {
  if (!process.env.ICE_SERVERS)
    return [{ urls: "stun:stun.l.google.com:19302" }];
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
    throw new Error(
      "ICE_SERVERS must be a non-empty array of valid ICE servers",
    );
  return servers;
}
const iceServers = getIceServers();
const landingPage = fs.readFileSync(
  path.join(__dirname, "public", "index.html"),
);
const cameraPage = fs.readFileSync(path.join(__dirname, "public", "m.html"));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (url.searchParams.has("s")) {
    if (!/^[a-f0-9]{8,32}$/.test(url.searchParams.get("s"))) {
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
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map();
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
wss.on("connection", (ws) => {
  ws.isAlive = true;
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
        typeof m.room !== "string" ||
        !/^[a-f0-9]{8,32}$/.test(m.room) ||
        !["desktop", "phone"].includes(m.role)
      ) {
        ws.close(1008, "Invalid room or role");
        return;
      }
      const members = rooms.get(m.room) || new Set();
      if ([...members].some((member) => member.role === m.role)) {
        ws.close(1008, "Role already connected");
        return;
      }
      ws.room = m.room;
      ws.role = m.role;
      if (!rooms.has(ws.room)) rooms.set(ws.room, members);
      members.add(ws);
      ws.send(JSON.stringify({ t: "config", iceServers }));
      others(ws).forEach((c) => {
        c.send(JSON.stringify({ t: "peer", up: true, role: ws.role }));
        ws.send(JSON.stringify({ t: "peer", up: true, role: c.role }));
      });
    } else if (
      m.t === "sig" &&
      ws.room &&
      m.data &&
      typeof m.data === "object" &&
      !Array.isArray(m.data)
    )
      others(ws).forEach((c) =>
        c.send(JSON.stringify({ t: "sig", data: m.data })),
      );
  });
  ws.on("close", () => {
    if (!ws.room) return;
    others(ws).forEach((c) =>
      c.send(JSON.stringify({ t: "peer", up: false, role: ws.role })),
    );
    const room = rooms.get(ws.room);
    if (!room) return;
    room.delete(ws);
    if (!room.size) rooms.delete(ws.room);
  });
});
server.listen(process.env.PORT || 8080, () =>
  console.log("CamShare server up"),
);

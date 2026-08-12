const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PARTICIPANTS = 8;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const rooms = new Map();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function cleanRoomId(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function validClientId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{16,64}$/.test(value);
}

function makeRoomId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join("");
  } while (rooms.has(id));
  return id;
}

function publicParticipants(room) {
  return [...room.values()]
    .map(({ clientId, name, joinedAt }) => ({ id: clientId, name, joinedAt }))
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const message = { type: "room-state", participants: publicParticipants(room) };
  for (const participant of room.values()) send(participant.socket, message);
}

function removeMembership(socket) {
  const roomId = socket.roomId;
  const clientId = socket.clientId;
  if (!roomId || !clientId) return;
  const room = rooms.get(roomId);
  socket.roomId = "";
  socket.clientId = "";
  if (!room) return;
  room.delete(clientId);
  if (room.size === 0) rooms.delete(roomId);
  else broadcastState(roomId);
}

function join(socket, roomId, clientId, name) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: "Комната не найдена или уже закрыта" };
  const existing = room.get(clientId);
  if (!existing && room.size >= MAX_PARTICIPANTS) return { ok: false, error: "В комнате уже 8 участников" };

  removeMembership(socket);
  if (existing?.socket && existing.socket !== socket) {
    existing.socket.roomId = "";
    existing.socket.clientId = "";
    existing.socket.close(1000, "Reconnected");
  }
  room.set(clientId, { clientId, name, joinedAt: existing?.joinedAt || Date.now(), socket });
  socket.roomId = roomId;
  socket.clientId = clientId;
  broadcastState(roomId);
  return { ok: true, roomId, participants: publicParticipants(room) };
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/health") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end('{"ok":true}');
    return;
  }

  const file = PUBLIC_FILES.get(pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  fs.readFile(path.join(__dirname, file[0]), (error, data) => {
    if (error) {
      response.writeHead(500);
      response.end("Server error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 100_000 });

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const requestId = message.requestId;

    if (message.type === "create") {
      const name = cleanName(message.name);
      if (!name || !validClientId(message.clientId)) {
        send(socket, { type: "ack", requestId, ok: false, error: "Проверь имя и попробуй ещё раз" });
        return;
      }
      removeMembership(socket);
      const roomId = makeRoomId();
      rooms.set(roomId, new Map());
      send(socket, { type: "ack", requestId, ...join(socket, roomId, message.clientId, name) });
      return;
    }

    if (message.type === "join") {
      const roomId = cleanRoomId(message.roomId);
      const name = cleanName(message.name);
      if (roomId.length !== 6 || !name || !validClientId(message.clientId)) {
        send(socket, { type: "ack", requestId, ok: false, error: "Проверь ID комнаты и имя" });
        return;
      }
      send(socket, { type: "ack", requestId, ...join(socket, roomId, message.clientId, name) });
      return;
    }

    if (message.type === "signal") {
      const room = rooms.get(socket.roomId);
      const recipient = room?.get(message.recipientId);
      const sender = room?.get(socket.clientId);
      if (!recipient || !sender || !["offer", "answer", "ice", "leave"].includes(message.signalType)) return;
      if (JSON.stringify(message.payload ?? {}).length > 24_000) return;
      send(recipient.socket, {
        type: "signal",
        senderId: sender.clientId,
        senderName: sender.name,
        signalType: message.signalType,
        payload: message.payload ?? {},
      });
      return;
    }

    if (message.type === "leave") removeMembership(socket);
  });

  socket.on("close", () => removeMembership(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      removeMembership(socket);
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 15_000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`VoiceLink запущен: http://localhost:${PORT}`);
});

function shutdown() {
  for (const socket of wss.clients) socket.close(1001, "Server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

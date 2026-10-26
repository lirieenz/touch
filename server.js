"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const RECONNECT_TIME = 30000;
const MAX_MESSAGE_LENGTH = 1200;
const MAX_VOICE_DATA_LENGTH = 450000;
const MAX_PAYLOAD = 600 * 1024;

const BASE_DIR = path.resolve(__dirname);

const server = http.createServer((req, res) => {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url || "/", "http://localhost").pathname
    );
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const relativePath =
    pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  const file = path.resolve(BASE_DIR, relativePath);

  if (
    file !== path.join(BASE_DIR, "index.html") &&
    !file.startsWith(BASE_DIR + path.sep)
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(file).toLowerCase();

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_PAYLOAD
});

/*
 * Rooms contain only the two active connections and connection
 * state. Chat messages and voice notes are never added to a room,
 * database, or server-side chat history.
 */
const rooms = new Map();

function sendJson(socket, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;

  try {
    socket.send(JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function sendError(socket, message) {
  sendJson(socket, {
    type: "error",
    message
  });
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function getRoomForSocket(socket) {
  if (!socket.room || !socket.partner) return null;

  const room = rooms.get(socket.room);
  if (!room) return null;

  if (socket.partner === "A" && room.a === socket) return room;
  if (socket.partner === "B" && room.b === socket) return room;

  return null;
}

function getPartner(room, socket) {
  if (room.a === socket) return room.b;
  if (room.b === socket) return room.a;
  return null;
}

function clearRoomTimer(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

function notifyPartner(room, socket, message) {
  const other = getPartner(room, socket);
  if (other && other.readyState === WebSocket.OPEN) {
    sendJson(other, message);
  }
}

/* PRIVATE CHAT: RELAY ONLY, NO SERVER-SIDE HISTORY */

function handleChatMessage(socket, message) {
  const room = getRoomForSocket(socket);

  if (!room) {
    sendError(socket, "You are not connected to a room.");
    return;
  }

  const other = getPartner(room, socket);

  if (!other || other.readyState !== WebSocket.OPEN) {
    sendError(socket, "Your partner is offline. Message not sent.");
    return;
  }

  let outgoing;

  if (message.type === "chat-message") {
    if (typeof message.text !== "string") return;

    const text = message.text.trim();

    if (!text || text.length > MAX_MESSAGE_LENGTH) return;

    outgoing = {
      type: "chat-message",
      from: socket.partner === "A" ? "benz :p" : "thea :p",
      text
    };
  } else if (message.type === "chat-signal") {
    const allowedSignals = [
      "miss-you",
      "kiss",
      "hug",
      "heartbeat"
    ];

    if (!allowedSignals.includes(message.signal)) return;

    outgoing = {
      type: "chat-signal",
      from: socket.partner === "A" ? "benz :p" : "thea :p",
      signal: message.signal
    };
  } else if (message.type === "voice-note") {
    if (
      typeof message.data !== "string" ||
      message.data.length < 1 ||
      message.data.length > MAX_VOICE_DATA_LENGTH
    ) {
      return;
    }

    const mime =
      typeof message.mime === "string" &&
      /^audio\/(webm|ogg|mp4|mpeg)(;[\w=.-]+)?$/i.test(message.mime)
        ? message.mime.slice(0, 80)
        : "audio/webm";

    outgoing = {
      type: "voice-note",
      from: socket.partner === "A" ? "benz :p" : "thea :p",
      data: message.data,
      mime,
      duration: Math.min(
        15,
        Math.max(0, Number(message.duration) || 0)
      )
    };
  } else if (message.type === "chat-clear") {
    outgoing = { type: "chat-cleared" };
  } else {
    return;
  }

  /*
   * Forward the message directly to the other member of this room.
   * Do not keep a copy in the room object or log its contents.
   */
  if (!sendJson(other, outgoing)) {
    sendError(socket, "Your partner is offline. Message not sent.");
  }
}

wss.on("connection", socket => {
  socket.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!message || typeof message.type !== "string") return;

    /* CREATE ROOM */

    if (message.type === "create") {
      const code = makeCode();

      rooms.set(code, {
        a: socket,
        b: null,
        aDisconnected: false,
        bDisconnected: false,
        cleanupTimer: null
      });

      socket.room = code;
      socket.partner = "A";

      sendJson(socket, {
        type: "room-created",
        code
      });

      return;
    }

    /* JOIN ROOM */

    if (message.type === "join") {
      const code =
        typeof message.code === "string"
          ? message.code.trim().toUpperCase()
          : "";

      const room = rooms.get(code);

      if (!room) {
        sendError(socket, "Room not found.");
        return;
      }

      if (room.b && !room.bDisconnected) {
        sendError(socket, "Room is already full.");
        return;
      }

      room.b = socket;
      room.bDisconnected = false;

      socket.room = code;
      socket.partner = "B";

      clearRoomTimer(room);

      sendJson(socket, {
        type: "joined",
        code
      });

      if (room.a && room.a.readyState === WebSocket.OPEN) {
        sendJson(room.a, {
          type: "partner-joined"
        });
      }

      return;
    }

    /* RECONNECT */

    if (message.type === "reconnect") {
      const code =
        typeof message.code === "string"
          ? message.code.trim().toUpperCase()
          : "";

      const requestedRole = message.role;
      const room = rooms.get(code);

      if (!room) {
        sendError(socket, "Room expired.");
        return;
      }

      if (requestedRole === "A") {
        room.a = socket;
        room.aDisconnected = false;
        socket.room = code;
        socket.partner = "A";
      } else if (requestedRole === "B") {
        room.b = socket;
        room.bDisconnected = false;
        socket.room = code;
        socket.partner = "B";
      } else {
        sendError(socket, "Invalid room role.");
        return;
      }

      clearRoomTimer(room);

      sendJson(socket, {
        type: "reconnected",
        code
      });

      const other = getPartner(room, socket);

      if (other && other.readyState === WebSocket.OPEN) {
        sendJson(other, {
          type: "partner-joined"
        });
      }

      return;
    }

    /* CONTROLLER TO RECEIVER */

    if (message.type === "control") {
      const room = getRoomForSocket(socket);

      if (!room || socket !== room.a) return;

      const intensity = Number(message.intensity);

      notifyPartner(room, socket, {
        type: "control",
        intensity: Number.isFinite(intensity)
          ? Math.max(0, Math.min(1, intensity))
          : 0,
        pattern: message.pattern === "pulse"
          ? "pulse"
          : "continuous"
      });

      return;
    }

    if (message.type === "heart") {
      const room = getRoomForSocket(socket);

      if (!room || socket !== room.a) return;

      notifyPartner(room, socket, {
        type: "heart"
      });

      return;
    }

    if (message.type === "stop") {
      const room = getRoomForSocket(socket);

      if (!room || socket !== room.a) return;

      notifyPartner(room, socket, {
        type: "stop"
      });

      return;
    }

    /* BIDIRECTIONAL PRIVATE CHAT */

    if (
      message.type === "chat-message" ||
      message.type === "chat-signal" ||
      message.type === "voice-note" ||
      message.type === "chat-clear"
    ) {
      handleChatMessage(socket, message);
    }
  });

  socket.on("close", () => {
    const code = socket.room;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    let wasCurrentSocket = false;

    if (room.a === socket) {
      room.aDisconnected = true;
      wasCurrentSocket = true;
    }

    if (room.b === socket) {
      room.bDisconnected = true;
      wasCurrentSocket = true;
    }

    /*
     * Ignore the close event of an old socket replaced by a reconnect.
     */
    if (!wasCurrentSocket) return;

    notifyPartner(room, socket, {
      type: "partner-left"
    });

    if (!room.cleanupTimer) {
      room.cleanupTimer = setTimeout(() => {
        const current = rooms.get(code);
        if (!current) return;

        const aGone = !current.a || current.aDisconnected;
        const bGone = !current.b || current.bDisconnected;

        if (aGone && bGone) {
          rooms.delete(code);
          return;
        }

        if (current.aDisconnected) current.a = null;
        if (current.bDisconnected) current.b = null;

        current.cleanupTimer = null;
      }, RECONNECT_TIME);
    }
  });

  socket.on("error", () => {
    /* Socket errors are handled by the connection closing. */
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
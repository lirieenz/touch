"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const RECONNECT_TIME = 30000;
const MAX_MESSAGE_LENGTH = 1200;
const MAX_VOICE_DATA_LENGTH = 450000;
const MAX_MEDIA_DATA_LENGTH = 7 * 1024 * 1024;
const MAX_PAYLOAD = 8 * 1024 * 1024;
const BASE_DIR = path.resolve(__dirname);
const INDEX_FILE = path.join(BASE_DIR, "index.html");

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
    file !== INDEX_FILE &&
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
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_PAYLOAD
});

/*
 * Rooms keep active connections and reconnect state.
 * Chat messages, voice notes, photos, and videos are relayed
 * directly to the other participant and are not saved as history.
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

/* Restore shared game state after joining or reconnecting. */
function sendGameState(socket, room) {
  if (!socket || !room) return;

  if (room.dareState) {
    sendJson(socket, {
      type: "game-dare-state",
      ...room.dareState
    });
  }

  if (room.quizState) {
    if (room.quizState.result) {
      sendJson(socket, {
        type: "game-quiz-result",
        ...room.quizState.result
      });
    } else {
      sendJson(socket, {
        type: "game-quiz-state",
        question: room.quizState.question,
        askerRole: room.quizState.askerRole,
        scores: room.quizState.scores
      });
    }
  }
}

function getSenderName(socket) {
  return socket.partner === "A" ? "benz :p" : "thea :p";
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

  const from = getSenderName(socket);
  let outgoing;

  if (message.type === "chat-message") {
    if (typeof message.text !== "string") return;

    const text = message.text.trim();

    if (!text || text.length > MAX_MESSAGE_LENGTH) return;

    outgoing = {
      type: "chat-message",
      from,
      text
    };
  } else if (message.type === "voice-note") {
    if (
      typeof message.data !== "string" ||
      message.data.length < 1 ||
      message.data.length > MAX_VOICE_DATA_LENGTH
    ) {
      sendError(socket, "Voice note is too large.");
      return;
    }

    const mime =
      typeof message.mime === "string" &&
      /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav)(;[\w=.-]+)?$/i.test(message.mime)
        ? message.mime.slice(0, 80)
        : "audio/webm";

    outgoing = {
      type: "voice-note",
      from,
      data: message.data,
      mime,
      duration: Math.min(
        15,
        Math.max(0, Number(message.duration) || 0)
      )
    };
  } else if (message.type === "chat-media") {
    if (
      typeof message.data !== "string" ||
      message.data.length < 1 ||
      message.data.length > MAX_MEDIA_DATA_LENGTH
    ) {
      sendError(socket, "Media attachment is too large to send.");
      return;
    }

    const mediaType = message.mediaType;

    if (mediaType !== "image" && mediaType !== "video") {
      sendError(socket, "Unsupported media type.");
      return;
    }

    const mime = typeof message.mime === "string"
      ? message.mime.slice(0, 80).toLowerCase()
      : "";

    const allowedImageMime =
      /^image\/(jpeg|png|webp|gif)$/i.test(mime);

    const allowedVideoMime =
      /^video\/(mp4|webm|quicktime|3gpp|x-m4v)$/i.test(mime);

    if (
      (mediaType === "image" && !allowedImageMime) ||
      (mediaType === "video" && !allowedVideoMime)
    ) {
      sendError(socket, "This media format is not supported.");
      return;
    }

    const name = typeof message.name === "string"
      ? message.name.replace(/[<>"]/g, "").slice(0, 100)
      : mediaType === "image" ? "photo.jpg" : "video.mp4";

    outgoing = {
      type: "chat-media",
      from,
      mediaType,
      mime,
      name,
      data: message.data
    };
  } else if (message.type === "chat-clear") {
    outgoing = {
      type: "chat-cleared"
    };
  } else {
    return;
  }

  /*
   * Forward directly to the other participant.
   * Do not store message contents in the room or log them.
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
        cleanupTimer: null,
        dareState: null,
        quizState: null
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
      const code = typeof message.code === "string"
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

      sendGameState(socket, room);

      if (room.a && room.a.readyState === WebSocket.OPEN) {
        sendGameState(room.a, room);
      }

      return;
    }

    /* RECONNECT */
    if (message.type === "reconnect") {
      const code = typeof message.code === "string"
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

      sendGameState(socket, room);

      if (other && other.readyState === WebSocket.OPEN) {
        sendGameState(other, room);
      }

      return;
    }

    /* SHARED COUPLES GAME: DARE ME */
    if (message.type === "game-dare-update") {
      const room = getRoomForSocket(socket);
      if (!room) return;

      const categories = ["playful", "romantic", "flirty"];
      const spiceLevels = ["sweet", "warm", "spicy"];

      if (
        typeof message.prompt !== "string" ||
        message.prompt.length > 300
      ) {
        return;
      }

      const category = categories.includes(message.category)
        ? message.category
        : "playful";

      const spice = spiceLevels.includes(message.spice)
        ? message.spice
        : "sweet";

      room.dareState = {
        category,
        spice,
        prompt: message.prompt,
        byRole: socket.partner
      };

      const outgoing = {
        type: "game-dare-state",
        ...room.dareState
      };

      sendJson(room.a, outgoing);
      sendJson(room.b, outgoing);

      return;
    }

    /* SHARED COUPLES GAME: HOW WELL DO YOU KNOW ME? */
    if (message.type === "game-quiz-start") {
      const room = getRoomForSocket(socket);

      if (
        !room ||
        typeof message.question !== "string" ||
        typeof message.answer !== "string"
      ) {
        return;
      }

      /*
       * After a round ends, only the person who guessed may
       * start the next round. This makes partners alternate roles.
       */
      if (
        room.quizState?.result &&
        socket.partner !== room.quizState.result.guesserRole
      ) {
        sendJson(socket, {
          type: "error",
          message: "It's your partner's turn to ask the next question."
        });
        return;
      }

      const question = message.question.trim().slice(0, 240);
      const answer = message.answer.trim().slice(0, 120);

      if (!question || !answer) return;

      const scores = room.quizState?.scores || {
        A: 0,
        B: 0
      };

      /*
       * The answer stays server-side until a guess is submitted.
       * Only the question, asker role, and scores are broadcast.
       */
      room.quizState = {
        question,
        answer,
        askerRole: socket.partner,
        scores,
        result: null
      };

      const outgoing = {
        type: "game-quiz-state",
        question,
        askerRole: socket.partner,
        scores
      };

      sendJson(room.a, outgoing);
      sendJson(room.b, outgoing);

      return;
    }

    /* HOW WELL DO YOU KNOW ME?: SUBMIT A GUESS */
    if (message.type === "game-quiz-guess") {
      const room = getRoomForSocket(socket);
      const quiz = room?.quizState;

      if (
        !room ||
        !quiz ||
        quiz.result ||
        socket.partner === quiz.askerRole
      ) {
        return;
      }

      if (typeof message.guess !== "string") return;

      const guess = message.guess.trim().slice(0, 120);
      if (!guess) return;

      const normalize = value =>
        value
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();

      const correct = normalize(guess) === normalize(quiz.answer);

      if (correct) {
        quiz.scores[socket.partner] =
          (quiz.scores[socket.partner] || 0) + 1;
      }

      quiz.result = {
        question: quiz.question,
        answer: quiz.answer,
        guess,
        correct,
        askerRole: quiz.askerRole,
        guesserRole: socket.partner,
        scores: quiz.scores
      };

      const outgoing = {
        type: "game-quiz-result",
        ...quiz.result
      };

      sendJson(room.a, outgoing);
      sendJson(room.b, outgoing);

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
      message.type === "voice-note" ||
      message.type === "chat-media" ||
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

    /* Ignore close events from old sockets replaced by reconnects. */
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
    /* The connection close handler handles cleanup. */
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
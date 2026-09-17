const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;


/* ==================================================
   HTTP SERVER
   ================================================== */

const server = http.createServer(
    (req, res) => {

        let file =
            req.url === "/"
                ? "index.html"
                : req.url.slice(1);


        file =
            path.join(
                __dirname,
                file
            );


        fs.readFile(
            file,
            (err, data) => {

                if (err) {

                    res.writeHead(
                        404
                    );

                    res.end(
                        "Not found"
                    );

                    return;

                }


                const ext =
                    path.extname(
                        file
                    );


                const types = {

                    ".html":
                        "text/html",

                    ".css":
                        "text/css",

                    ".js":
                        "text/javascript"

                };


                res.writeHead(
                    200,
                    {
                        "Content-Type":
                            types[ext] ||
                            "text/plain"
                    }
                );


                res.end(
                    data
                );

            }
        );

    }
);


/* ==================================================
   WEBSOCKET SERVER
   ================================================== */

const wss =
    new WebSocket.Server({
        server
    });


const rooms =
    new Map();


const RECONNECT_TIME =
    30000;


/* ==================================================
   ROOM CODE
   ================================================== */

function makeCode() {

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";


    let code;


    do {

        code = "";


        for (
            let i = 0;
            i < 6;
            i++
        ) {

            code +=
                chars[
                    Math.floor(
                        Math.random() *
                        chars.length
                    )
                ];

        }

    }
    while (
        rooms.has(code)
    );


    return code;

}


/* ==================================================
   CONNECTION
   ================================================== */

wss.on(
    "connection",
    socket => {


        socket.on(
            "message",
            raw => {

                let message;


                try {

                    message =
                        JSON.parse(
                            raw
                        );

                }

                catch {

                    return;

                }


                /* ==================================
                   CREATE
                   ================================== */

                if (
                    message.type ===
                    "create"
                ) {

                    const code =
                        makeCode();


                    rooms.set(
                        code,
                        {

                            a:
                                socket,

                            b:
                                null,

                            aDisconnected:
                                false,

                            bDisconnected:
                                false,

                            cleanupTimer:
                                null

                        }
                    );


                    socket.room =
                        code;

                    socket.partner =
                        "A";


                    socket.send(
                        JSON.stringify({

                            type:
                                "room-created",

                            code:
                                code

                        })
                    );


                    return;

                }


                /* ==================================
                   JOIN
                   ================================== */

                if (
                    message.type ===
                    "join"
                ) {

                    const code =
                        message.code
                        ?.toUpperCase();


                    const room =
                        rooms.get(
                            code
                        );


                    if (
                        !room
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "error",

                                message:
                                    "Room not found."

                            })
                        );


                        return;

                    }


                    /*
                       Allow B to reconnect through
                       the normal Join flow if the
                       previous B connection died.
                    */

                    if (
                        room.b &&
                        !room.bDisconnected
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "error",

                                message:
                                    "Room is already full."

                            })
                        );


                        return;

                    }


                    room.b =
                        socket;

                    room.bDisconnected =
                        false;


                    socket.room =
                        code;

                    socket.partner =
                        "B";


                    if (
                        room.cleanupTimer
                    ) {

                        clearTimeout(
                            room.cleanupTimer
                        );

                        room.cleanupTimer =
                            null;

                    }


                    socket.send(
                        JSON.stringify({

                            type:
                                "joined",

                            code:
                                code

                        })
                    );


                    if (
                        room.a &&
                        room.a.readyState ===
                        WebSocket.OPEN
                    ) {

                        room.a.send(
                            JSON.stringify({

                                type:
                                    "partner-joined"

                            })
                        );

                    }


                    return;

                }


                /* ==================================
                   RECONNECT
                   ================================== */

                if (
                    message.type ===
                    "reconnect"
                ) {

                    const code =
                        message.code
                        ?.toUpperCase();


                    const requestedRole =
                        message.role;


                    const room =
                        rooms.get(
                            code
                        );


                    if (
                        !room
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "error",

                                message:
                                    "Room expired."

                            })
                        );


                        return;

                    }


                    if (
                        requestedRole ===
                        "A"
                    ) {

                        room.a =
                            socket;

                        room.aDisconnected =
                            false;

                        socket.room =
                            code;

                        socket.partner =
                            "A";

                    }


                    else if (
                        requestedRole ===
                        "B"
                    ) {

                        room.b =
                            socket;

                        room.bDisconnected =
                            false;

                        socket.room =
                            code;

                        socket.partner =
                            "B";

                    }


                    else {

                        return;

                    }


                    if (
                        room.cleanupTimer
                    ) {

                        clearTimeout(
                            room.cleanupTimer
                        );

                        room.cleanupTimer =
                            null;

                    }


                    socket.send(
                        JSON.stringify({

                            type:
                                "reconnected",

                            code:
                                code

                        })
                    );


                    const other =
                        requestedRole === "A"
                            ? room.b
                            : room.a;


                    if (
                        other &&
                        other.readyState ===
                        WebSocket.OPEN
                    ) {

                        other.send(
                            JSON.stringify({

                                type:
                                    "partner-joined"

                            })
                        );

                    }


                    return;

                }


                /* ==================================
                   CONTROL
                   ================================== */

                if (
                    message.type ===
                    "control"
                ) {

                    const room =
                        rooms.get(
                            socket.room
                        );


                    if (
                        !room
                    ) {

                        return;

                    }


                    /*
                       ONLY Partner A controls B.
                    */

                    if (
                        socket !==
                        room.a
                    ) {

                        return;

                    }


                    const other =
                        room.b;


                    if (
                        other &&
                        other.readyState ===
                        WebSocket.OPEN
                    ) {

                        other.send(
                            JSON.stringify({

                                type:
                                    "control",

                                x:
                                    message.x,

                                y:
                                    message.y,

                                intensity:
                                    message.intensity,

                                pattern:
                                    message.pattern,

                                drawing:
                                    message.drawing

                            })
                        );

                    }


                    return;

                }


                /* ==================================
                   HEART
                   ================================== */

                if (
                    message.type ===
                    "heart"
                ) {

                    const room =
                        rooms.get(
                            socket.room
                        );


                    if (
                        !room
                    ) {

                        return;

                    }


                    if (
                        socket !==
                        room.a
                    ) {

                        return;

                    }


                    const other =
                        room.b;


                    if (
                        other &&
                        other.readyState ===
                        WebSocket.OPEN
                    ) {

                        other.send(
                            JSON.stringify({

                                type:
                                    "heart"

                            })
                        );

                    }


                    return;

                }


                /* ==================================
                   STOP
                   ================================== */

                if (
                    message.type ===
                    "stop"
                ) {

                    const room =
                        rooms.get(
                            socket.room
                        );


                    if (
                        !room
                    ) {

                        return;

                    }


                    if (
                        socket !==
                        room.a
                    ) {

                        return;

                    }


                    const other =
                        room.b;


                    if (
                        other &&
                        other.readyState ===
                        WebSocket.OPEN
                    ) {

                        other.send(
                            JSON.stringify({

                                type:
                                    "stop"

                            })
                        );

                    }


                    return;

                }

            }
        );


        /* ==========================================
           DISCONNECT
           ========================================== */

        socket.on(
            "close",
            () => {

                const code =
                    socket.room;


                if (
                    !code
                ) {

                    return;

                }


                const room =
                    rooms.get(
                        code
                    );


                if (
                    !room
                ) {

                    return;

                }


                /*
                   Only mark this side disconnected
                   if this is STILL the current socket.

                   This is important after reconnecting.
                */

                let wasCurrentSocket =
                    false;


                if (
                    socket ===
                    room.a
                ) {

                    room.aDisconnected =
                        true;

                    wasCurrentSocket =
                        true;

                }


                if (
                    socket ===
                    room.b
                ) {

                    room.bDisconnected =
                        true;

                    wasCurrentSocket =
                        true;

                }


                /*
                   An old socket closing after a
                   reconnect should do nothing.
                */

                if (
                    !wasCurrentSocket
                ) {

                    return;

                }


                const other =
                    socket === room.a
                        ? room.b
                        : room.a;


                if (
                    other &&
                    other.readyState ===
                    WebSocket.OPEN
                ) {

                    other.send(
                        JSON.stringify({

                            type:
                                "partner-left"

                        })
                    );

                }


                if (
                    !room.cleanupTimer
                ) {

                    room.cleanupTimer =
                        setTimeout(
                            () => {

                                const current =
                                    rooms.get(
                                        code
                                    );


                                if (
                                    !current
                                ) {

                                    return;

                                }


                                const aGone =
                                    !current.a ||
                                    current.aDisconnected;


                                const bGone =
                                    !current.b ||
                                    current.bDisconnected;


                                if (
                                    aGone &&
                                    bGone
                                ) {

                                    rooms.delete(
                                        code
                                    );

                                    return;

                                }


                                if (
                                    current.aDisconnected
                                ) {

                                    current.a =
                                        null;

                                }


                                if (
                                    current.bDisconnected
                                ) {

                                    current.b =
                                        null;

                                }


                                current.cleanupTimer =
                                    null;

                            },
                            RECONNECT_TIME
                        );

                }

            }
        );

    }
);


/* ==================================================
   START
   ================================================== */

server.listen(
    PORT,
    () => {

        console.log(
            `Server running at http://localhost:${PORT}`
        );

    }
);
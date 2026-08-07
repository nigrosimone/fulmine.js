// In its own file rather than inline, because helmet's default content security policy refuses
// inline scripts: the demo runs the real middleware, so it has to live by its rules.

const out = document.getElementById("out");

/**
 * What the server said it spent, read from the browser's own performance entry rather than from
 * the header text: the Server-Timing header is parsed for us into PerformanceServerTiming, which
 * is the same data DevTools draws in the timing panel.
 *
 * The entry appears after the response is complete, and not always in the same tick, so this waits
 * a beat for it. Cross-origin would need Timing-Allow-Origin; this page is same-origin, so the
 * durations come through.
 *
 * https://web.dev/articles/custom-metrics#server-timing-api
 *
 * @param {string} url
 * @returns {Promise<string>} a line to print, or "" when the browser has no entry for it
 */
async function serverTiming(url) {
    if (!("getEntriesByType" in performance)) return "";
    const absolute = new URL(url, location.href).href;
    for (let attempt = 0; attempt < 3; attempt++) {
        const entry = performance
            .getEntriesByType("resource")
            .reverse()
            .find((candidate) => candidate.name === absolute);
        const timings = entry && entry.serverTiming;
        if (timings && timings.length > 0) {
            return timings
                .map(
                    (timing) =>
                        `${timing.name}${timing.description ? ` (${timing.description})` : ""}: ${timing.duration} ms`
                )
                .join("\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return "";
}

/** Prints a request and what came back, headers included, since those are helmet's doing. */
async function show(method, url, body) {
    out.textContent = `${method} ${url}\n…`;
    const started = performance.now();
    try {
        const response = await fetch(url, {
            method,
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        const took = Math.round(performance.now() - started);
        const text = await response.text();
        let printed = text;
        try {
            printed = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            // not json, print it as it came
        }
        const headers = [...response.headers.entries()]
            .filter(([name]) => name !== "date")
            .map(([name, value]) => `${name}: ${value}`)
            .join("\n");
        // what the round trip cost here against what the server says it spent inside itself: the
        // gap between the two is the network and the browser, which is the point of the header
        const timing = await serverTiming(url);
        const server = timing ? `\n\nwhat the server measured (Server-Timing)\n${timing}` : "";
        out.textContent = `${method} ${url} → ${response.status} (${took} ms round trip)${server}\n\n${headers}\n\n${printed}`;
    } catch (err) {
        out.textContent = `${method} ${url} → failed: ${err.message}`;
    }
}

for (const button of document.querySelectorAll("[data-get]")) {
    button.addEventListener("click", () => show("GET", button.dataset.get));
}
for (const button of document.querySelectorAll("[data-post]")) {
    button.addEventListener("click", () => show("POST", button.dataset.post, { hello: "from the browser", n: 42 }));
}

// --- the websocket half -------------------------------------------------------------------

const log = document.getElementById("log");
const roomInput = document.getElementById("room");
const textInput = document.getElementById("text");
const sendButton = document.getElementById("send");
const connectButton = document.getElementById("connect");
const people = document.getElementById("people");
let socket = null;

/** @param {string} text @param {boolean} [system] */
function append(text, system) {
    const item = document.createElement("li");
    item.textContent = text;
    if (system) item.className = "system";
    log.appendChild(item);
    log.scrollTop = log.scrollHeight;
}

function connect() {
    if (socket) {
        socket.close();
        socket = null;
    }
    const room = roomInput.value.trim();
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${encodeURIComponent(room)}`;
    append(`connecting to /ws/${room}`, true);
    socket = new WebSocket(url);

    socket.onopen = () => {
        textInput.disabled = false;
        sendButton.disabled = false;
        connectButton.textContent = "Reconnect";
    };
    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "joined") append(`joined ${data.room}`, true);
        else if (data.type === "people") people.textContent = `${data.people} connected`;
        else if (data.type === "message") append(data.text);
    };
    socket.onclose = () => {
        textInput.disabled = true;
        sendButton.disabled = true;
        // the upgrade hook refuses a room name it does not like, and the socket never opens
        append("disconnected. A room name must be lowercase letters, digits or dashes.", true);
    };
}

function send() {
    const text = textInput.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(text);
    textInput.value = "";
}

connectButton.addEventListener("click", connect);
sendButton.addEventListener("click", send);
textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") send();
});

connect();

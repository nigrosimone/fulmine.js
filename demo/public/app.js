// In its own file rather than inline, because helmet's default content security policy refuses
// inline scripts: the demo runs the real middleware, so it has to live by its rules.

const out = document.getElementById("out");

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
        out.textContent = `${method} ${url} → ${response.status} (${took} ms)\n\n${headers}\n\n${printed}`;
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

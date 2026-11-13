// Bull Board through @bull-board/express, with an in-memory queue so no Redis is needed.
//
// The adapter builds its own app with the real `express()` it depends on, and the user mounts it
// with `app.use(path, adapter.getRouter())`. On the Fulmine arm that is an Express app mounted in a
// Fulmine one, so this case is about that seam: the page rendered with ejs, the statics, the JSON
// API and the body parsed by Express's own `express.json()`.

const { createBullBoard } = require("@bull-board/api");
const { BaseAdapter } = require("@bull-board/api/dist/queueAdapters/base.js");
const { ExpressAdapter } = require("@bull-board/express");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13814;

/** A job as Bull Board reads one: a fixed clock, so the two arms print the same bytes. */
class MemoryJob {
    constructor(id, name, data, state) {
        this.id = id;
        this.name = name;
        this.data = data;
        this.state = state;
        this.attemptsMade = 0;
    }

    toJSON() {
        return { id: this.id, name: this.name, data: this.data, timestamp: 1700000000000, attemptsMade: 0, opts: {} };
    }

    async getState() {
        return this.state;
    }
}

/** Only what the routes asked below call; the rest throws, so a new call shows up as a 500. */
class MemoryAdapter extends BaseAdapter {
    constructor(name) {
        super("bullmq", {});
        this.name = name;
        this.paused = false;
        this.jobs = [new MemoryJob("1", "welcome", { to: "a@example.com" }, "completed")];
    }

    getName() {
        return this.name;
    }

    async getRedisInfo() {
        return null;
    }

    getStatuses() {
        return ["latest", "active", "waiting", "completed", "failed", "delayed", "paused"];
    }

    getJobStatuses() {
        return ["active", "waiting", "completed", "failed", "delayed", "paused"];
    }

    async getJobCounts() {
        const counts = { active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
        for (const job of this.jobs) counts[job.state]++;
        return counts;
    }

    async getJobs(statuses) {
        return this.jobs.filter((job) => statuses.includes(job.state));
    }

    async getJob(id) {
        return this.jobs.find((job) => job.id === id);
    }

    async addJob(name, data) {
        const job = new MemoryJob(String(this.jobs.length + 1), name, data, "waiting");
        this.jobs.push(job);
        return job;
    }

    async isPaused() {
        return this.paused;
    }

    async pause() {
        this.paused = true;
    }

    async resume() {
        this.paused = false;
    }

    async getGlobalConcurrency() {
        return null;
    }

    async getJobSchedulersCount() {
        return 0;
    }
}

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/queues");
createBullBoard({ queues: [new MemoryAdapter("mail")], serverAdapter });

/** Asks the board and prints the answer, a page as its length. */
function ask(path, init, asLength = false) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, init);
        const text = await response.text();
        console.log(asLength ? `${text.length} bytes` : text);
    };
}

/** Sends a JSON body with the given method. */
function send(method, path, body) {
    return ask(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const app = express();
app.use("/queues", serverAdapter.getRouter());
app.listen(PORT, async () => {
    await sequential([
        // the page, rendered by ejs through the inner app's res.render
        ask("/queues", undefined, true),
        // a deep link the board answers with the same page
        ask("/queues/queue/mail", undefined, true),
        // a static from the inner app's express.static
        ask("/queues/static/favicon-32x32.png", undefined, true),
        ask("/queues/static/missing.js"),
        ask("/queues/api/queues"),
        ask("/queues/api/queues?activeQueue=mail&status=completed&page=1"),
        ask("/queues/api/queues/mail/1"),
        // a job that is not there, and a queue that is not there: Bull Board's own 404s
        ask("/queues/api/queues/mail/99"),
        ask("/queues/api/queues/nope/1"),
        // the body goes through the inner app's express.json()
        send("POST", "/queues/api/queues/mail/add", { name: "reminder", data: { to: "b@example.com" } }),
        send("PUT", "/queues/api/queues/mail/pause", {}),
        ask("/queues/api/queues?activeQueue=mail&status=waiting&page=1"),
        // malformed JSON, refused by the inner express.json() and answered by the board's error handler
        ask("/queues/api/queues/mail/add", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{"
        })
    ]);
    process.exit(0);
});

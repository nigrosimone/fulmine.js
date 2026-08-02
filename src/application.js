/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// H3App, DeclarativeResponse and _cfg all exist at runtime but are missing from the
// declaration file the package ships, so the module is read through a loose alias
const uWS = require("uWebSockets.js");
const uWSAny = /** @type {any} */ (uWS);
const Router = require("./router.js");
const {
    removeDuplicateSlashes,
    defaultSettings,
    compileTrust,
    createETagGenerator,
    fastQueryParse,
    NullObject
} = require("./utils.js");
const querystring = require("fast-querystring");
const ViewClass = require("./view.js");
const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");
const cluster = require("cluster");

const cpuCount = os.cpus().length;

const workers = [];
let taskKey = 0;
const workerTasks = new NullObject();

class FSWorker {
    /**
     * A worker thread that does nothing but read files, so a read does not sit on the event loop.
     * It is unref'd, so an idle one does not keep the process alive, and it is shared between every
     * app in the process rather than started per app.
     */
    constructor() {
        this.busy = false;
        this.worker = new Worker(path.join(__dirname, "worker.js"));

        this.worker.on("message", (message) => {
            this.busy = false;
            if (message.err) {
                workerTasks[message.key].reject(new Error(message.err));
            } else {
                // worker transfers file contents as an ArrayBuffer; wrap it in a Buffer (zero-copy) so
                // consumers get the same type as fs.readFile. A bare ArrayBuffer is rejected by wrapped
                // res.end() implementations (e.g. express-session calls Buffer.byteLength on the chunk).
                workerTasks[message.key].resolve(
                    message.data instanceof ArrayBuffer ? Buffer.from(message.data) : message.data
                );
            }
            delete workerTasks[message.key];
        });
        this.worker.unref();

        workers.push(this);
    }
}

class Application extends Router {
    /**
     * @param {object} [settings] the options express() takes. uwsOptions goes to uWS and decides
     *   between an HTTP, an HTTPS and an HTTP/3 server; threads sizes the file-reading pool, and 0
     *   turns it off; uwsApp adopts an existing uWS app instead of making one. Everything else is
     *   an application setting and lands next to the defaults.
     */
    constructor(settings = new NullObject()) {
        super(settings);
        if (!settings?.uwsOptions) {
            settings.uwsOptions = {};
        }
        if (typeof settings.threads !== "number") {
            settings.threads = cpuCount > 1 ? 1 : 0;
        }
        if (settings.uwsApp) {
            this.uwsApp = settings.uwsApp;
        } else if (settings.http3) {
            if (!settings.uwsOptions.key_file_name || !settings.uwsOptions.cert_file_name) {
                throw new Error("uwsOptions.key_file_name and uwsOptions.cert_file_name are required for HTTP/3");
            }
            this.uwsApp = uWSAny.H3App(settings.uwsOptions);
        } else if (settings.uwsOptions.key_file_name && settings.uwsOptions.cert_file_name) {
            this.uwsApp = uWS.SSLApp(settings.uwsOptions);
        } else {
            this.uwsApp = uWS.App(settings.uwsOptions);
        }
        this.ssl = settings.uwsOptions.key_file_name && settings.uwsOptions.cert_file_name;
        this.cache = new NullObject();
        this.engines = { __proto__: null };
        this.locals = {
            settings: this.settings
        };
        this.listenCalled = false;
        this.workers = [];
        for (let i = 0; i < settings.threads; i++) {
            if (workers[i]) {
                this.workers[i] = workers[i];
            } else {
                this.workers[i] = new FSWorker();
            }
        }
        this.port = undefined;
        this.listening = false;
        // the host handed to listen(), which is all address() has to go on
        this._listenHost = undefined;
        for (const key in defaultSettings) {
            if (typeof this.settings[key] === "undefined") {
                if (typeof defaultSettings[key] === "function") {
                    this.settings[key] = defaultSettings[key](this);
                } else {
                    this.settings[key] = defaultSettings[key];
                }
            }
        }
        this.set("view", ViewClass);
        this.set("views", path.resolve("views"));
    }

    /**
     * Parks a promise's settle functions under a key the worker can send back, since a worker
     * message carries data and not closures. The counter wraps rather than growing without bound,
     * a million tasks being far more than can be outstanding at once.
     *
     * @param {(value: any) => void} resolve
     * @param {(err: any) => void} reject
     * @returns {number} the key to send to the worker
     */
    createWorkerTask(resolve, reject) {
        const key = taskKey++;
        workerTasks[key] = { resolve, reject };
        if (key > 1000000) {
            taskKey = 0;
        }
        return key;
    }

    /**
     * Reads a file on one of the file threads, picked at random, rather than on the event loop.
     * Only worth it below the size where the copy back costs more than the read, which is why
     * res.sendFile uses it for small files and streams the rest.
     *
     * @param {string} path absolute path to read
     * @returns {Promise<Buffer>}
     */
    readFileWithWorker(path) {
        return new Promise((resolve, reject) => {
            const worker = this.workers[Math.floor(Math.random() * this.workers.length)];
            const key = this.createWorkerTask(resolve, reject);
            worker.busy = true;
            worker.worker.postMessage({ key, type: "readFile", path });
        });
    }

    /**
     * Reads or writes an application setting.
     *
     * Called with one argument it is the getter, the same as `app.get(key)`. The check is on
     * `arguments.length`, so an explicit `set(key, undefined)` still writes.
     *
     * Some keys have a side effect: `trust proxy`, `query parser` and `etag` compile the value
     * into a function kept alongside it, `views` is resolved to an absolute path, and setting
     * `env` to "production" turns the view cache on.
     *
     * @param {string} key setting name
     * @param {*} [value] value to store; omit to read instead
     * @returns {*} the app, for chaining, or the value when reading
     */
    set(key, value) {
        if (arguments.length === 1) {
            return this.get(key);
        }
        if (key === "trust proxy") {
            if (!value) {
                delete this.settings["trust proxy fn"];
            } else {
                this.settings["trust proxy fn"] = compileTrust(value);
            }
        } else if (key === "query parser") {
            if (value === "extended") {
                this.settings["query parser fn"] = fastQueryParse;
            } else if (value === "simple") {
                this.settings["query parser fn"] = querystring.parse;
            } else if (typeof value === "function") {
                this.settings["query parser fn"] = value;
            } else {
                this.settings["query parser fn"] = undefined;
            }
        } else if (key === "env") {
            if (value === "production") {
                this.settings["view cache"] = true;
            } else {
                this.settings["view cache"] = undefined;
            }
        } else if (key === "views") {
            this.settings[key] = path.resolve(value);
            return this;
        } else if (key === "etag") {
            if (typeof value === "function") {
                this.settings["etag fn"] = value;
            } else {
                switch (value) {
                    case true:
                    case "weak":
                        this.settings["etag fn"] = createETagGenerator({ weak: true });
                        break;
                    case "strong":
                        this.settings["etag fn"] = createETagGenerator({ weak: false });
                        break;
                    case false:
                        delete this.settings["etag fn"];
                        break;
                    default:
                        throw new Error(`Invalid etag mode: ${value}`);
                }
            }
        }

        this.settings[key] = value;
        return this;
    }

    /**
     * Sets a setting to true, side effects and all.
     * @param {string} key setting name
     * @returns {this} the app, for chaining
     */
    enable(key) {
        this.set(key, true);
        return this;
    }

    /**
     * Sets a setting to false, side effects and all.
     * @param {string} key setting name
     * @returns {this} the app, for chaining
     */
    disable(key) {
        this.set(key, false);
        return this;
    }

    /**
     * Whether a setting is truthy. Reads this app's own settings, without falling back to a
     * parent app the way get() does.
     * @param {string} key setting name
     * @returns {boolean}
     */
    enabled(key) {
        return !!this.settings[key];
    }

    /**
     * Whether a setting is falsy.
     * @param {string} key setting name
     * @returns {boolean}
     */
    disabled(key) {
        return !this.settings[key];
    }

    /**
     * Registers the catch-all uWS handler, which is what serves every request that no optimized
     * route took natively. It walks this app's own chain and, when nothing in it answered, decides
     * between an error, the automatic OPTIONS reply and a 404.
     */
    #createRequestHandler() {
        this.uwsApp.any("/*", async (res, req) => {
            const { request, response } = this.handleRequest(res, req);

            const matchedRoute = await this._routeRequest(request, response);
            if (!matchedRoute && !response.headersSent && !response.aborted) {
                if (request._error) {
                    return this._handleError(request._error, null, request, response);
                }
                if (request._isOptions && request._matchedMethods.size > 0) {
                    // sorted and ", "-joined, so the header reads the same whatever order the
                    // routes were registered in. same shape as the router's own OPTIONS reply
                    const allowedMethods = Array.from(request._matchedMethods).sort().join(", ");
                    response.setHeader("Allow", allowedMethods);
                    // the router package answers this one itself, with a plain-text body, the
                    // nosniff header and end() rather than send(), so no ETag comes with it
                    response.setHeader("Content-Type", "text/plain");
                    response.setHeader("X-Content-Type-Options", "nosniff");
                    response.end(allowedMethods);
                    return;
                }
                response.status(404);
                this._sendErrorPage(request, response, `Cannot ${request.method} ${request.path}`, false);
            }
        });
    }

    /**
     * Binds the server and starts accepting requests.
     *
     * Unlike Express this returns the app itself rather than an `http.Server`, because there is
     * no node HTTP server underneath. The app carries the parts of that interface that make
     * sense here: `address()`, `close()`, `listening`, and the 'listening' and 'close' events.
     * Anything needing a real `http.Server`, socket.io being the usual case, should reach for
     * `app.uwsApp` instead.
     *
     * The callback runs on the next tick, as Express runs it, and receives an error if the bind
     * failed. Passing a path instead of a port listens on a unix socket.
     *
     * @param {number|string} [port] port, or a unix socket path; 0 picks a free port
     * @param {string} [host] interface to bind; every interface when omitted
     * @param {(err?: Error) => void} [callback] called once bound, or with the bind error
     * @returns {this} the app, which doubles as the server handle
     */
    listen(port, host, callback) {
        this._compileOptimizedRoutes();
        this.#createRequestHandler();
        // support listen(callback)
        if (!callback && typeof port === "function") {
            callback = port;
            port = 0;
        }
        // support listen(port, callback)
        if (typeof host === "function") {
            callback = host;
            host = undefined;
        }
        // uWS runs this handler from inside its own listen(), so everything it hands back to the
        // caller is deferred a tick. Express binds synchronously too but reports through events,
        // and node emits both 'listening' and 'error' from a process.nextTick.
        const onListen = (socket) => {
            if (!socket) {
                /** @type {NodeJS.ErrnoException} */
                const err = new Error("listen EADDRINUSE: address already in use :::" + port);
                err.code = "EADDRINUSE";
                // Express 5 registers the listen callback on 'error' as well as on 'listening',
                // so a failed bind arrives at the callback rather than being thrown past it
                if (callback) {
                    return process.nextTick(() => callback.call(this, err));
                }
                // no callback means no 'error' listener either, and an EventEmitter carrying an
                // unhandled error rethrows it from the tick that emitted it, not from listen()
                return process.nextTick(() => {
                    throw err;
                });
            }
            // the port is known synchronously, as it is in Express, so address() works as soon as
            // listen() returns. The callback is not: running it here would run it before listen()
            // had returned, and `const server = app.listen(p, () => server.address())` - the form
            // the Express docs use - would die on the temporal dead zone.
            this.port = uWS.us_socket_local_port(socket);
            this.listening = true;
            this._listenHost = host;
            process.nextTick(() => {
                // `this` is the app, which is what listen() returns here. Express binds it to the
                // http.Server, which is what listen() returns there, so
                // `function () { this.address() }` reads the same on both.
                // The callback goes first: in Express it is registered as a 'listening' listener
                // before the caller can add any of their own.
                if (callback) callback.call(this);
                this.emit("listening");
            });
        };
        let fn = "listen";
        const args = [];
        // 1 = exclusive port, 0 = shared port
        const uwsOptions = cluster.isPrimary ? 1 : 0;
        if (typeof port !== "number") {
            if (!isNaN(Number(port))) {
                port = Number(port);
                args.push(port, uwsOptions, onListen);
                if (host) {
                    args.unshift(host);
                }
            } else {
                fn = "listen_unix";
                args.push(onListen, port);
            }
        } else {
            args.push(port, uwsOptions, onListen);
            if (host) {
                args.unshift(host);
            }
        }
        this.listenCalled = true;
        this.uwsApp[fn](...args);
        return this;
    }

    /**
     * The bound address, or null when not listening.
     * @returns {{address: string, family: string, port: number}|null}
     */
    address() {
        if (!this.listening || !this.port) {
            return null;
        }
        // uWS hands back the port and nothing else, so the address reported is the one we asked
        // it to bind. No host means every interface, which node reports as "::". A hostname is
        // reported as written, since what it resolved to is not readable back from here: node
        // would say "::1" where this says "localhost".
        const host = this._listenHost;
        if (!host) {
            return { address: "::", family: "IPv6", port: this.port };
        }
        return { address: host, family: host.includes(":") ? "IPv6" : "IPv4", port: this.port };
    }

    /**
     * The full mount path of this app, walking up through every parent it is mounted on.
     * A top level app returns the empty string rather than "/".
     * @returns {string}
     */
    path() {
        const paths = [this.mountpath];
        let parent = this.parent;
        while (parent) {
            paths.unshift(parent.mountpath);
            parent = parent.parent;
        }
        const path = removeDuplicateSlashes(paths.join(""));
        return path === "/" ? "" : path;
    }

    /**
     * Registers a template engine for a file extension.
     *
     * The leading dot is optional: "pug" and ".pug" register the same thing.
     *
     * @param {string} ext file extension the engine handles
     * @param {(path: string, options: object, callback: (err: Error|null, rendered?: string) => void) => void} fn
     *   the engine, in the callback style consolidate-style engines use
     * @returns {this} the app, for chaining
     * @throws {Error} if fn is not a function
     */
    engine(ext, fn) {
        if (typeof fn !== "function") {
            throw new Error("callback function required");
        }
        const extension = ext[0] !== "." ? "." + ext : ext;
        this.engines[extension] = fn;
        return this;
    }

    /**
     * Renders a view and hands the result to the callback, without sending anything.
     * `res.render()` is the one that responds.
     *
     * `app.locals` and `options._locals` are merged into the options, in that order, so a
     * per-request local wins over an application-wide one. Caching follows the "view cache"
     * setting unless `options.cache` says otherwise.
     *
     * A function in the options position is taken as the callback.
     *
     * @param {string} name view name, resolved against the "views" setting
     * @param {Record<string, any>} [options] locals for the view
     * @param {(err: Error|null, html?: string) => void} [callback] receives the rendered view. It
     *   is what render is for, so leaving it out throws, as it does in Express
     */
    render(name, options, callback) {
        if (typeof options === "function") {
            callback = /** @type {any} */ (options);
            options = new NullObject();
        }
        // render exists to hand the result somewhere, so there is always a callback by this point:
        // either the third argument or the second one, shuffled above
        const done = /** @type {(err: Error|null, html?: string) => void} */ (callback);
        if (!options) {
            options = new NullObject();
        } else {
            options = Object.assign({}, options);
        }
        for (const key in this.locals) {
            options[key] = this.locals[key];
        }

        if (options._locals) {
            for (const key in options._locals) {
                options[key] = options._locals[key];
            }
        }

        if (options.cache == null) {
            options.cache = this.enabled("view cache");
        }

        let view;
        if (options.cache) {
            view = this.cache[name];
        }

        if (!view) {
            const View = this.get("view");
            view = new View(name, {
                defaultEngine: this.get("view engine"),
                root: this.get("views"),
                engines: { ...this.engines }
            });
            if (!view.path) {
                const dirs =
                    Array.isArray(view.root) && view.root.length > 1
                        ? 'directories "' +
                          view.root.slice(0, -1).join('", "') +
                          '" or "' +
                          view.root[view.root.length - 1] +
                          '"'
                        : 'directory "' + view.root + '"';

                /** @type {Error & { view?: unknown }} */
                const err = new Error(`Failed to lookup view "${name}" in views ${dirs}`);
                err.view = view;
                return done(err);
            }

            if (options.cache) {
                this.cache[name] = view;
            }
        }

        try {
            view.render(options, done);
        } catch (err) {
            done(/** @type {Error} */ (err));
        }
    }

    /**
     * Stops listening and emits 'close'.
     *
     * The callback is the first 'close' listener, so it runs before any added afterwards. Closing
     * a server that was not listening still calls back, with an ERR_SERVER_NOT_RUNNING error, the
     * way node does.
     *
     * @param {(err?: Error) => void} [callback] called once closed
     * @returns {this} the app, for chaining
     */
    close(callback) {
        const wasListening = this.listening;
        if (this.listenCalled && wasListening) {
            this.uwsApp.close();
        }
        this.listening = false;
        // in Express the close callback is nothing more than the first 'close' listener, and a
        // server that was not running still gets called back, with an error
        if (callback) {
            this.once("close", () => {
                if (wasListening) {
                    return callback();
                }
                /** @type {NodeJS.ErrnoException} */
                const err = new Error("Server is not running.");
                err.code = "ERR_SERVER_NOT_RUNNING";
                callback(err);
            });
        }
        process.nextTick(() => this.emit("close"));
        return this;
    }
}

// An app is an object here, where in Express it is a function. Router._asCallable() would make it
// one, it was tried, and it works: vhost("api.example.com", subApp) then calls the app and the app
// answers, which is what the callable form is for.
//
// It was reverted because supertest is worth more than vhost is. `request(app)` reads
// `typeof app === "function"` and, when it is one, wraps it in http.createServer and hands it
// node's IncomingMessage and ServerResponse. There is no node HTTP server under this, so the
// request has nothing to be routed against and every call times out. As an object, supertest takes
// the other branch, calls app.listen(0) and makes a real request, which works today.
//
// Middleware that calls an app keeps working when it runs inside the chain, because there it is
// handed this project's own req and res: app.handle(req, res, next) is the form to give it, and
// vhost is the one case that cannot be written that way. Making both work means a shim presenting
// a node request behind the uWS calls Request and Response make, which is a real piece of work and
// not this one.
module.exports = function (options) {
    return new Application(options);
};

// the class itself, so index.js can expose its prototype as express.application does. Adding a
// method to that prototype adds it to every app, which is what the property is for.
module.exports.Application = Application;

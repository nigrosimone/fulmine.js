/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

This file is derived from Ultimate Express and has been modified.

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

const { loadUWS } = require("./uws.js");
const Router = require("./router.js");
const {
    removeDuplicateSlashes,
    defaultSettings,
    compileTrust,
    createETagGenerator,
    fastQueryParse,
    durationSetting,
    NullObject,
    settingsEpoch
} = require("./utils.js");
const parseQuery = require("./parse-query.js");
const Request = require("./request.js");
const Response = require("./response.js");
const ViewClass = require("./view.js");
const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");
const cluster = require("cluster");
const { registerWebSocketRoutes } = require("./websocket.js");
const { addServerMembers } = require("./server-shape.js");
const { workerCount, forkWorkers, isSupervising, becomeSupervisor } = require("./cluster.js");

const cpuCount = os.cpus().length;

// marks a "trust proxy" the application never set, under express's key, so a sub-app may inherit
const trustProxyDefaultSymbol = "@@symbol:trust_proxy_default";

const workers = /** @type {FSWorker[]} */ ([]);
let taskKey = 0;
const workerTasks = new NullObject();

class FSWorker {
    /** Whether a read is in flight on it. @type {boolean} */
    busy = false;

    /** @type {Worker} */
    worker;

    /**
     * A worker thread that only reads files, unref'd and shared by every app in the process.
     */
    constructor() {
        // its own execArgv: a --import written for the parent (Angular's route extraction loader
        // reads workerData) throws in a thread that only reads files
        this.worker = new Worker(path.join(__dirname, "worker.js"), { execArgv: [] });

        this.worker.on("message", (message) => {
            // under --watch node reports {"watch:import": [...]} here too, with no key of ours
            if (workerTasks[message.key] === undefined) return;
            this.busy = false;
            if (message.err) {
                workerTasks[message.key].reject(new Error(message.err));
            } else {
                // the transferred ArrayBuffer as a Buffer, zero-copy: express-session calls
                // Buffer.byteLength on what res.end() gets
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

// the worker path's bound, a bigger file streams
const FILE_CACHE_MAX_ENTRY = 768 * 1024;
// oldest-first once the budget is spent
const FILE_CACHE_BUDGET = 64 * 1024 * 1024;

class Application extends Router {
    /**
     * A mounted app's settings chain onto its parent's, as in express.
     *
     * @type {boolean}
     */
    _inheritsSettings = true;

    /**
     * See Router#_isApplication.
     * @type {boolean}
     */
    _isApplication = true;

    /**
     * Whether express.testing already compiled the routes, a second time would register them twice.
     * @type {boolean|undefined}
     */
    _testingCompiled;

    /**
     * The uWS app once made, or the one settings.uwsApp handed in. See the uwsApp getter.
     * @type {any}
     */
    _uwsApp;

    /** What uWS.App or uWS.SSLApp is given, kept until the app is made. */
    _uwsOptions;

    /** The forks the cluster setting asks for, 0 when none. @type {number} */
    _clusterWorkers;

    /** Whether uwsOptions carries a key and a certificate, which picks uWS.SSLApp. @type {string|undefined} */
    ssl;

    /** express's app.cache, the view cache. @type {Record<string, any>} */
    cache = new NullObject();

    /** The view engines by extension, chained onto the parent's on mount. @type {Record<string, any>} */
    engines = { __proto__: null };

    /** A null prototype, as express gives app.locals. @type {Record<string, any>} */
    locals = Object.create(null);

    /** The request prototype layer of this app, what app.request extends. @type {Request} */
    request;

    /** @type {Response} */
    response;

    /** @type {boolean} */
    listenCalled = false;

    /** @type {FSWorker[]} */
    workers = [];

    /** @type {number|undefined} */
    port;

    /** @type {boolean} */
    listening = false;

    /** What address() has to go on. @type {string|undefined} */
    _listenHost;

    /** close() stops the listen socket, then waits for the pending responses, as node does. @type {import("uWebSockets.js").us_listen_socket|undefined} */
    _listenSocket;

    /** The fork supervisor, in the primary of a clustered app only. @type {{stop: () => void}|undefined} */
    _clusterHandle;

    /** readSmallFile's cache, by absolute path. @type {Map<string, {mtimeMs: number, size: number, data: Buffer}>} */
    _fileCache = new Map();

    /** @type {number} */
    _fileCacheBytes = 0;

    /** readSmallFile's reads in flight, so concurrent asks share one. @type {Map<string, Promise<Buffer>>} */
    _fileReadsInFlight = new Map();

    /**
     * The responses being served, an intrusive list (a Set paid hashing per request). A holder
     * object: the callable app copies own scalars by value.
     * @type {{head: Response|null}}
     */
    _pending = { head: null };

    /** Whether close() is waiting for the pending responses. @type {boolean} */
    _draining = false;

    /**
     * @param {Record<string, any>} [settings] the options express() takes: uwsOptions (HTTP or HTTPS), threads
     *   (the file-reading pool, 0 off), cluster, uwsApp (an existing uWS app); the rest are
     *   application settings
     */
    constructor(settings = new NullObject()) {
        super(settings);
        if (!settings?.uwsOptions) {
            settings.uwsOptions = {};
        }
        if (typeof settings.threads !== "number") {
            settings.threads = cpuCount > 1 ? 1 : 0;
        }
        // counted here so a bad setting throws where the app is written, and the process becomes
        // the supervisor before any app listens
        this._clusterWorkers = workerCount(settings.cluster);
        if (this._clusterWorkers > 0 && cluster.isPrimary) {
            becomeSupervisor();
        }
        if (settings.http3) {
            // uWS.H3App segfaults on Linux and hangs on Windows in the pinned build, verified
            // 2026-08-05 with uWS alone
            throw new Error(
                "http3 is not usable with the pinned uWebSockets.js build: its H3App crashes " +
                    "during construction. Track uNetworking/uWebSockets.js for working QUIC support."
            );
        }
        this.ssl = settings.uwsOptions.key_file_name && settings.uwsOptions.cert_file_name;
        // the uWS app is made on first use, see the uwsApp getter
        this._uwsApp = settings.uwsApp;
        this._uwsOptions = settings.uwsOptions;
        this.locals.settings = this.settings;
        // a request/response prototype layer per app, so extending app.request cannot leak into
        // another app. The constructors are written out: the implicit one spreads its arguments,
        // an allocation per request
        this._request = class extends Request {
            /**
             * @param {import("uWebSockets.js").HttpRequest} req uWS request
             * @param {import("uWebSockets.js").HttpResponse} res uWS response
             * @param {Application} app the application this request arrived at
             * @param {import("./router-utils.js").NativePreset} [preset] a literal registration's constants
             * @param {import("./router-utils.js").SkipHolder} [skipHolder] where a granted header skip lives
             */
            constructor(req, res, app, preset, skipHolder) {
                super(req, res, app, preset, skipHolder);
            }
        };
        this._response = class extends Response {
            /**
             * @param {import("uWebSockets.js").HttpResponse} res uWS response
             * @param {Request} req the Request, already built
             * @param {Application} app the application this request arrived at
             */
            constructor(res, req, app) {
                super(res, req, app);
            }
        };
        this.request = this._request.prototype;
        this.response = this._response.prototype;
        this.on("mount", (parent) => {
            // the parent's extensions and engines show through, as express chains them
            if (parent.request) {
                Object.setPrototypeOf(this.request, parent.request);
            }
            if (parent.response) {
                Object.setPrototypeOf(this.response, parent.response);
            }
            if (parent.engines) {
                Object.setPrototypeOf(this.engines, parent.engines);
            }
            // a "trust proxy" never set here is inherited: the defaults are deleted so get() falls through
            if (
                this._settings[trustProxyDefaultSymbol] === true &&
                typeof parent._settings["trust proxy fn"] === "function"
            ) {
                delete this._settings["trust proxy"];
                delete this._settings["trust proxy fn"];
            }
        });
        for (let i = 0; i < settings.threads; i++) {
            if (workers[i]) {
                this.workers[i] = workers[i];
            } else {
                this.workers[i] = new FSWorker();
            }
        }
        /** @type {{_pendingIn?: {head: Response|null}}} */ (this.response)._pendingIn = this._pending;
        // at construction as express reads it; an empty NODE_ENV is development
        if (typeof this._settings.env === "undefined") {
            this._settings.env = process.env.NODE_ENV || "development";
        }
        for (const key in defaultSettings) {
            if (typeof this._settings[key] === "undefined") {
                if (typeof defaultSettings[key] === "function") {
                    this._settings[key] = defaultSettings[key](this);
                } else {
                    this._settings[key] = defaultSettings[key];
                }
            }
        }
        Object.defineProperty(this._settings, trustProxyDefaultSymbol, {
            configurable: true,
            value: true
        });
        this.set("view", ViewClass);
        this.set("views", path.resolve("views"));
    }

    /**
     * Parks a promise's settle functions under a key the worker sends back. The counter wraps at a
     * million.
     *
     * @param {(value: Buffer) => void} resolve
     * @param {(err: Error) => void} reject
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
     * Reads a file on a file thread picked at random. Only worth it for a small file, res.sendFile
     * streams the rest.
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
     * A small file through the worker pool: concurrent asks share one read, and an unchanged file
     * (by the stat the caller paid for) comes from a bounded cache, on a macrotask as a worker's
     * answer would. `app.set("file cache", false)` keeps only the shared read.
     *
     * @param {string} fullpath
     * @param {import("fs").Stats} stat
     * @returns {Promise<Buffer>}
     */
    readSmallFile(fullpath, stat) {
        const caching = this.get("file cache");
        if (caching) {
            const cached = this._fileCache.get(fullpath);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                return new Promise((resolve) => setImmediate(resolve, cached.data));
            }
        }
        let pending = this._fileReadsInFlight.get(fullpath);
        if (pending) {
            return pending;
        }
        pending = this.readFileWithWorker(fullpath).then((data) => {
            if (caching && stat.size <= FILE_CACHE_MAX_ENTRY) {
                const existing = this._fileCache.get(fullpath);
                if (existing) {
                    this._fileCacheBytes -= existing.size;
                    this._fileCache.delete(fullpath);
                }
                this._fileCache.set(fullpath, { mtimeMs: stat.mtimeMs, size: stat.size, data });
                this._fileCacheBytes += stat.size;
                for (const [key, entry] of this._fileCache) {
                    if (this._fileCacheBytes <= FILE_CACHE_BUDGET) {
                        break;
                    }
                    this._fileCache.delete(key);
                    this._fileCacheBytes -= entry.size;
                }
            }
            return data;
        });
        this._fileReadsInFlight.set(fullpath, pending);
        const clear = () => this._fileReadsInFlight.delete(fullpath);
        pending.then(clear, clear);
        return pending;
    }

    /**
     * Reads or writes a setting; `set(key, undefined)` still writes. `trust proxy`, `query parser`
     * and `etag` compile the value into a function kept beside it.
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
                // compiled, not deleted: an explicit false must shadow a parent's setting
                this._settings["trust proxy fn"] = compileTrust(false);
            } else {
                this._settings["trust proxy fn"] = compileTrust(value);
            }
            Object.defineProperty(this._settings, trustProxyDefaultSymbol, {
                configurable: true,
                value: false
            });
        } else if (key === "stat cache") {
            this._settings["stat cache ms"] = durationSetting(value, "stat cache");
        } else if (key === "query parser") {
            if (value === "extended") {
                this._settings["query parser fn"] = fastQueryParse;
            } else if (value === "simple" || value === true) {
                this._settings["query parser fn"] = parseQuery;
            } else if (typeof value === "function") {
                this._settings["query parser fn"] = value;
            } else if (value === false) {
                this._settings["query parser fn"] = undefined;
            } else {
                throw new TypeError("unknown value for query parser function: " + value);
            }
        } else if (key === "etag methods") {
            // fulmine's own: the methods whose send() computes an ETag, all of them unset as
            // express does; ["GET", "HEAD"] measured +21% on a 4KB POST answer, see issue #10
            if (value != null && (!Array.isArray(value) || value.some((m) => typeof m !== "string"))) {
                throw new TypeError('"etag methods" wants an array of method names, or null for all of them');
            }
            value = value == null ? undefined : value.map((/** @type {string} */ m) => m.toUpperCase());
        } else if (key === "etag") {
            // the header skips stay: the skip branch reads the conditional pair by name whatever
            // this says
            if (typeof value === "function") {
                this._settings["etag fn"] = value;
            } else {
                switch (value) {
                    case true:
                    case "weak":
                        this._settings["etag fn"] = createETagGenerator({ weak: true });
                        break;
                    case "strong":
                        this._settings["etag fn"] = createETagGenerator({ weak: false });
                        break;
                    case false:
                        delete this._settings["etag fn"];
                        break;
                    default:
                        throw new TypeError("unknown value for etag function: " + value);
                }
            }
        }

        this._settings[key] = value;
        // see Router#_hot
        settingsEpoch.n++;
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
     * Whether a setting is truthy, through the parent as get() reads it.
     * @param {string} key setting name
     * @returns {boolean}
     */
    enabled(key) {
        return !!this.get(key);
    }

    /**
     * Whether a setting is falsy.
     * @param {string} key setting name
     * @returns {boolean}
     */
    disabled(key) {
        return !this.get(key);
    }

    /**
     * Router's handleRequest plus the pending list a graceful close() drains.
     *
     * @param {import("uWebSockets.js").HttpResponse} res uWS response
     * @param {import("uWebSockets.js").HttpRequest} req uWS request, readable only during this call
     * @param {import("./router-utils.js").NativePreset} [preset] see nativePreset
     * @param {import("./router-utils.js").SkipHolder} [skipHolder] forwarded whole, dropping it
     *   silently turned every skip off
     * @returns {Request} the request, with the response as request.res
     */
    handleRequest(res, req, preset, skipHolder) {
        const request = super.handleRequest(res, req, preset, skipHolder);
        // unlinked by the close listener the Response already has; an aborted response only
        // flips its flags, so close()'s drain sweeps by them too
        const response = request.res;
        const pending = this._pending;
        response._pendingLinked = true;
        response._pendingPrev = null;
        response._pendingNext = pending.head;
        if (pending.head !== null) {
            pending.head._pendingPrev = response;
        }
        pending.head = response;
        return request;
    }

    /**
     * The µWS app, for what µWS offers that this does not (socket.io attaches to it). Made on
     * first ask, so an app served through node's http never loads the binary, see src/uws.js.
     *
     * @returns {any}
     */
    get uwsApp() {
        if (this._uwsApp === undefined) {
            const uWS = loadUWS();
            this._uwsApp = this.ssl ? uWS.SSLApp(this._uwsOptions) : uWS.App(this._uwsOptions);
        }
        return this._uwsApp;
    }

    /** The catch-all uWS handler, for every request no native route took. */
    _createRequestHandler() {
        this.uwsApp.any("/*", (res, req) => this._serveGeneric(res, req));
    }

    /**
     * Serves one request by walking the chain: the catch-all, and what a native registration
     * falls back to on a request it must not answer itself, see the case guard in _registerUwsRoute.
     *
     * @param {import("uWebSockets.js").HttpResponse} res the uWS response
     * @param {import("uWebSockets.js").HttpRequest} req the uWS request
     */
    _serveGeneric(res, req) {
        const request = this.handleRequest(res, req);
        const response = request.res;
        if (request._mustRefuse === true) {
            return this._refuseRequest(response);
        }
        try {
            this._routeRequestDirect(request, response);
        } finally {
            // the synchronous stretch ran under uWS's own cork
            response._corkNeeded = true;
            // an abort can only arrive after this callback returns
            if (!response.finished) {
                this._armAbort(res, response);
            }
        }
    }

    /**
     * Binds and starts accepting. Returns the app, which answers as an `http.Server`; socket.io
     * wants `app.uwsApp`. A path instead of a port is a unix socket.
     *
     * @param {number|string} [port] port, or a unix socket path; 0 picks a free port
     * @param {string} [host] interface to bind; every interface when omitted
     * @param {number} [backlog] accepted for node's signature; uWS sizes its own queue
     * @param {(err?: Error) => void} [callback] called once bound, or with the bind error
     * @returns {this} the app, which doubles as the server handle
     */
    listen(port, host, backlog, callback) {
        // With { cluster } the primary only forks: each worker binds this port with SO_REUSEPORT
        // and everything below runs once per worker. The test is the process, not this app: a
        // second app without a cluster setting would take its port here and every worker would fail
        if (cluster.isPrimary && isSupervising()) {
            if (this._clusterWorkers > 0 && !this._clusterHandle) {
                this._clusterHandle = forkWorkers(this._clusterWorkers);
            }
            return this;
        }
        this._compileOptimizedRoutes();
        registerWebSocketRoutes(this);
        this._createRequestHandler();
        // node's shapes: (cb), (port, cb), (port, host, cb), (port, host, backlog, cb)
        if (typeof port === "function") {
            callback = port;
            port = 0;
        } else if (typeof host === "function") {
            callback = host;
            host = undefined;
        } else if (typeof backlog === "function") {
            callback = backlog;
        }
        // a bare listen() binds an OS-assigned port, as node does
        if (port == null) {
            port = 0;
        }
        // uWS runs this inside its own listen(), so everything reported to the caller is deferred
        // a tick, as node emits 'listening' and 'error'
        const onListen = (/** @type {import("uWebSockets.js").us_listen_socket|false} */ socket) => {
            if (!socket) {
                /** @type {NodeJS.ErrnoException} */
                const err = new Error("listen EADDRINUSE: address already in use :::" + port);
                err.code = "EADDRINUSE";
                // Express 5 hands a failed bind to the listen callback
                if (callback) {
                    return process.nextTick(() => callback.call(this, err));
                }
                // without one it is thrown from the tick, as an unhandled 'error' would be
                return process.nextTick(() => {
                    throw err;
                });
            }
            // the port synchronously, so address() works as soon as listen() returns; the
            // callback on a tick, `const server = app.listen(p, () => server.address())` would
            // hit the temporal dead zone
            this.port = loadUWS().us_socket_local_port(socket);
            this.listening = true;
            this._listenHost = host;
            this._listenSocket = socket;
            process.nextTick(() => {
                // `this` is what listen() returns, as in Express; the callback first, as the
                // first 'listening' listener
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
     * Publishes a message to every socket subscribed to a topic, from outside any socket.
     *
     * @param {string} topic
     * @param {string|ArrayBuffer|Buffer} message
     * @param {boolean} [isBinary]
     * @param {boolean} [compress]
     * @returns {boolean} whether the topic had anyone listening
     */
    publish(topic, message, isBinary, compress) {
        return this.uwsApp.publish(topic, message, isBinary, compress);
    }

    /**
     * How many sockets are subscribed to a topic.
     *
     * @param {string} topic
     * @returns {number}
     */
    numSubscribers(topic) {
        return this.uwsApp.numSubscribers(topic);
    }

    /**
     * express 5's `app.router`, for a caller walking `app.router.stack`: the application itself.
     *
     * @returns {this}
     */
    get router() {
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
        // uWS hands back only the port: no host is "::" as node reports it, a hostname is
        // reported as written where node would say "::1"
        const host = this._listenHost;
        if (!host) {
            return { address: "::", family: "IPv6", port: this.port };
        }
        return { address: host, family: host.includes(":") ? "IPv6" : "IPv4", port: this.port };
    }

    /**
     * The full mount path through every parent, "" at the top level.
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
     * Registers a template engine for an extension, with or without the dot.
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
     * Renders a view into the callback, without sending: `res.render()` is the one that responds.
     * `app.locals` then `options._locals` are merged in, so a per-request local wins. Caching
     * follows the "view cache" setting unless `options.cache` says otherwise.
     *
     * @param {string} name view name, resolved against the "views" setting
     * @param {Record<string, any>|((err: Error|null, html?: string) => void)} [options] locals, or
     *   the callback in its place
     * @param {(err: Error|null, html?: string) => void} [callback] required, as in Express
     */
    render(name, options, callback) {
        if (typeof options === "function") {
            callback = /** @type {(err: Error|null, html?: string) => void} */ (options);
            options = new NullObject();
        }
        const done = /** @type {(err: Error|null, html?: string) => void} */ (callback);
        // express's order: app.locals, then res.locals as _locals, then what was passed
        const opts = options || new NullObject();
        options = new NullObject();
        for (const key in this.locals) {
            options[key] = this.locals[key];
        }
        if (opts._locals) {
            for (const key in opts._locals) {
                options[key] = opts._locals[key];
            }
        }
        for (const key in opts) {
            options[key] = opts[key];
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
                // the object itself, as express hands it: a sub-app reaches its parent's engines
                // through the prototype chain, and a view caches a required engine back here
                engines: this.engines
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
     * Stops accepting connections, lets in-flight requests finish, then emits 'close'. uWS's
     * close() kills every connection, so it runs only after the last pending response, to drop the
     * idle keep-alive ones. Closing a server that was not listening calls back with
     * ERR_SERVER_NOT_RUNNING, as node does.
     *
     * @param {(err?: Error) => void} [callback] called once closed
     * @returns {this} the app, for chaining
     */
    close(callback) {
        // the primary of a clustered app never bound anything: it stops the workers, each of
        // which drains itself
        if (this._clusterHandle) {
            this._clusterHandle.stop();
            this._clusterHandle = undefined;
            if (callback) {
                this.once("close", () => callback());
            }
            process.nextTick(() => this.emit("close"));
            return this;
        }
        const wasListening = this.listening;
        this.listening = false;
        // the callback is the first 'close' listener, as in Express
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
        if (!this.listenCalled || !wasListening) {
            // a close during a drain does not emit again, as in node
            if (!this._draining) {
                process.nextTick(() => this.emit("close"));
            }
            return this;
        }
        if (this._listenSocket) {
            loadUWS().us_listen_socket_close(this._listenSocket);
            this._listenSocket = undefined;
        }
        this._draining = true;
        const finish = () => {
            this._draining = false;
            this.uwsApp.close();
            this.emit("close");
        };
        if (this._pending.head === null) {
            process.nextTick(finish);
            return this;
        }
        // an aborted response only flips its flags, so the drain sweeps by them; the timer keeps
        // the loop alive
        const sweep = setInterval(() => {
            let response = this._pending.head;
            while (response !== null) {
                const next = response._pendingNext;
                if (response.finished || response.aborted) {
                    response._unlinkPending();
                }
                response = next;
            }
            if (this._pending.head === null) {
                clearInterval(sweep);
                finish();
            }
        }, 10);
        return this;
    }
}

// An app is a function, as in Express: vhost and the like call it. supertest then wraps it in
// http.createServer, which is what src/node-shim.js serves.
/** @param {object} [options] the settings express() takes, see the Application constructor */
module.exports = function (options) {
    return new Application(options)._asCallable();
};

// the class, so index.js exposes its prototype as express.application
module.exports.Application = Application;

// what makes an application answer as an http.Server, see server-shape.js
addServerMembers(Application.prototype);

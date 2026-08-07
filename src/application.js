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

const uWS = require("uWebSockets.js");
const Router = require("./router.js");
const {
    removeDuplicateSlashes,
    defaultSettings,
    compileTrust,
    createETagGenerator,
    fastQueryParse,
    NullObject
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

const cpuCount = os.cpus().length;

// marks a "trust proxy" that was never set by the application, under the key express uses, so a
// mounted sub-app knows it may inherit the parent's
const trustProxyDefaultSymbol = "@@symbol:trust_proxy_default";

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

// the worker path's own bound: a file bigger than this streams instead, so the cache never
// holds an entry the read path would not have produced whole
const FILE_CACHE_MAX_ENTRY = 768 * 1024;
// oldest-first once the budget is spent. A static directory that beats this is being served by
// something other than an application server anyway
const FILE_CACHE_BUDGET = 64 * 1024 * 1024;

class Application extends Router {
    /**
     * An application reads an unset routing flag from the app it is mounted on, which a plain
     * Router does not: express chains a mounted app's settings onto its parent's.
     *
     * @type {boolean}
     */
    _inheritsSettings = true;

    /**
     * An application, which a plain Router is not. See Router#_isApplication.
     * @type {boolean}
     */
    _isApplication = true;

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
            // uWS.H3App exists in the pinned build but its QUIC stack does not: the constructor
            // segfaults on Linux and hangs forever on Windows before serving a single request,
            // verified 2026-08-05 with uWS alone. A clear throw beats a native crash; this
            // branch goes back to H3App once uNetworking ships working QUIC in the prebuilts.
            throw new Error(
                "http3 is not usable with the pinned uWebSockets.js build: its H3App crashes " +
                    "during construction. Track uNetworking/uWebSockets.js for working QUIC support."
            );
        } else if (settings.uwsOptions.key_file_name && settings.uwsOptions.cert_file_name) {
            this.uwsApp = uWS.SSLApp(settings.uwsOptions);
        } else {
            this.uwsApp = uWS.App(settings.uwsOptions);
        }
        this.ssl = settings.uwsOptions.key_file_name && settings.uwsOptions.cert_file_name;
        this.cache = new NullObject();
        this.engines = { __proto__: null };
        // a null prototype, as express gives app.locals, so a local named like an Object method
        // is just a local
        this.locals = Object.create(null);
        this.locals.settings = this.settings;
        // each app gets its own request/response prototype layer, so extending app.request cannot
        // leak into another app; a mounted sub-app re-parents its layer onto the parent's below.
        // The constructors are written out: the implicit derived one spreads its arguments, which
        // was an allocation on every request
        this._request = class extends Request {
            /**
             * @param {any} req
             * @param {any} res
             * @param {any} app
             * @param {any} [preset]
             * @param {any} [skipHolder]
             */
            constructor(req, res, app, preset, skipHolder) {
                super(req, res, app, preset, skipHolder);
            }
        };
        this._response = class extends Response {
            /**
             * @param {any} res
             * @param {any} req
             * @param {any} app
             */
            constructor(res, req, app) {
                super(res, req, app);
            }

            /**
             * Node counts an explicit writeHead as the head gone out; remembered here so the
             * automatic OPTIONS reply can refuse to add headers after it, as express's does.
             *
             * @param {number} statusCode
             * @param {string|Record<string, any>} [statusMessage]
             * @param {Record<string, any>} [headers]
             * @returns {this}
             */
            writeHead(statusCode, statusMessage, headers) {
                this._headWritten = true;
                return super.writeHead(statusCode, statusMessage, headers);
            }
        };
        this.request = this._request.prototype;
        this.response = this._response.prototype;
        this.on("mount", (parent) => {
            // the parent's extensions show through, and an override here stays here. Only an
            // application has a layer to hang onto: a plain router mount leaves things alone
            if (parent.request) {
                Object.setPrototypeOf(this.request, parent.request);
            }
            if (parent.response) {
                Object.setPrototypeOf(this.response, parent.response);
            }
            // and the engines with them, which is the same chaining express does: a sub-app renders
            // with whatever the parent registered unless it registered its own. Without this a
            // render inside a mounted app looked for a module named after the extension.
            if (parent.engines) {
                Object.setPrototypeOf(this.engines, parent.engines);
            }
            // a "trust proxy" this app never set is inherited from the parent, as express does:
            // the defaults are deleted so get() falls through to the parent's value
            if (
                this.settings[trustProxyDefaultSymbol] === true &&
                typeof parent.settings["trust proxy fn"] === "function"
            ) {
                delete this.settings["trust proxy"];
                delete this.settings["trust proxy fn"];
            }
        });
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
        // the uWS listen socket, and the responses being served right now: close() stops the
        // first and waits for the second, the way node's server.close() does
        this._listenSocket = undefined;
        // readSmallFile's cache and its in-flight reads, see the method
        this._fileCache = new Map();
        this._fileCacheBytes = 0;
        this._fileReadsInFlight = new Map();
        // the responses being served right now, an intrusive list: linking is three pointer
        // stores where a Set paid identity hashing and table upkeep per request. A holder object
        // rather than a bare field, because the callable app copies own scalars by value and two
        // copies of a head would disagree; an object rides by reference, the way the Set did
        this._pending = /** @type {{ head: any }} */ ({ head: null });
        // on the per-app prototype layer, not per response, same as the Set was
        /** @type {any} */ (this.response)._pendingIn = this._pending;
        this._draining = false;
        // read here, at construction, the way express does; an empty NODE_ENV means development,
        // which the ?? in the shared default would miss
        if (typeof this.settings.env === "undefined") {
            this.settings.env = process.env.NODE_ENV || "development";
        }
        for (const key in defaultSettings) {
            if (typeof this.settings[key] === "undefined") {
                if (typeof defaultSettings[key] === "function") {
                    this.settings[key] = defaultSettings[key](this);
                } else {
                    this.settings[key] = defaultSettings[key];
                }
            }
        }
        // non-enumerable, so the marker never shows up walking the settings
        Object.defineProperty(this.settings, trustProxyDefaultSymbol, {
            configurable: true,
            value: true
        });
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
     * A small file through the worker pool, with two things on top: concurrent asks for the same
     * path share one read, and the bytes of an unchanged file come from a bounded cache,
     * validated against the stat the caller already paid for, so a touched file is re-read.
     * A hit completes on a macrotask, which is when a worker's answer would have arrived; code
     * that passed the suites against worker timing keeps passing against this.
     * `app.set("file cache", false)` turns the cache off; the shared read stays.
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
        // never cached past settlement: a rejection clears the slot the same way
        const clear = () => this._fileReadsInFlight.delete(fullpath);
        pending.then(clear, clear);
        return pending;
    }

    /**
     * Reads or writes an application setting. One argument is the getter, and the check is on
     * `arguments.length`, so `set(key, undefined)` still writes. Some keys have a side effect:
     * `trust proxy`, `query parser` and `etag` compile the value into a function kept beside it,
     * and `views` becomes an absolute path.
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
                // compiled, not deleted: an explicit false must shadow a parent's setting when
                // this app is mounted, and a deleted key would read straight through to it
                this.settings["trust proxy fn"] = compileTrust(false);
            } else {
                this.settings["trust proxy fn"] = compileTrust(value);
            }
            // set explicitly, so a mount no longer inherits the parent's
            Object.defineProperty(this.settings, trustProxyDefaultSymbol, {
                configurable: true,
                value: false
            });
        } else if (key === "query parser") {
            if (value === "extended") {
                this.settings["query parser fn"] = fastQueryParse;
            } else if (value === "simple" || value === true) {
                this.settings["query parser fn"] = parseQuery;
            } else if (typeof value === "function") {
                this.settings["query parser fn"] = value;
            } else if (value === false) {
                this.settings["query parser fn"] = undefined;
            } else {
                // express's wording, which applications match on
                throw new TypeError("unknown value for query parser function: " + value);
            }
        } else if (key === "views") {
            // a list of directories is searched in order by View.lookup, each resolved here once
            this.settings[key] = Array.isArray(value) ? value.map((dir) => path.resolve(dir)) : path.resolve(value);
            return this;
        } else if (key === "etag") {
            // an etag arriving after listen would make send consult freshness headers the
            // header-skip routes never copied, so those skips are taken back
            if (value !== false && this._skipPresets?.size) {
                for (const preset of this._skipPresets) {
                    preset.skipHeaders = false;
                    preset.skipQuery = false;
                }
                this._skipPresets.clear();
            }
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
                        // express's wording, which applications match on
                        throw new TypeError("unknown value for etag function: " + value);
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
     * Whether a setting is truthy. Reads through to the app this one is mounted on, as get() does
     * and as express does: mounting chains a sub-app's settings onto its parent's.
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
     * Router's handleRequest plus the bookkeeping a graceful close() needs: every live response
     * is held in a set until it finishes, so close() knows when the last one is done. Native
     * routes and the catch-all both come through here, since both call it on the app.
     *
     * @param {any} res uWS response
     * @param {any} req uWS request, readable only during this call
     * @param {any} [preset] a literal registration's constants, see nativePreset in the router
     * @param {any} [skipHolder] where a granted header skip lives, forwarded whole: dropping
     *   it here silently turned every skip off, since the native closures call this override
     * @returns {any} the request, with the response reachable as request.res
     */
    handleRequest(res, req, preset, skipHolder) {
        const request = super.handleRequest(res, req, preset, skipHolder);
        // removal rides the close listener the Response constructor already has, since a second
        // once() per request measured a tenth of a microsecond on the hot path.
        // An aborted response only flips its flags without emitting 'close', which is why
        // close()'s drain also sweeps the list by those flags instead of trusting this alone
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
     * Registers the catch-all uWS handler, which is what serves every request that no optimized
     * route took natively. It walks this app's own chain and, when nothing in it answered, decides
     * between an error, the automatic OPTIONS reply and a 404.
     */
    _createRequestHandler() {
        this.uwsApp.any("/*", (res, req) => this._serveGeneric(res, req));
    }

    /**
     * Serves one request by walking this app's chain, with no registration-time shortcut. It is
     * what the catch-all runs, and also what a native registration falls back to when it sees a
     * request it must not answer itself, see the case guard in Router#_registerUwsRoute.
     *
     * @param {any} res the uWS response
     * @param {any} req the uWS request
     */
    async _serveGeneric(res, req) {
        const request = this.handleRequest(res, req);
        const response = request.res;
        // armed up front here: this handler awaits, so the response outlives the callback
        // on every path through it
        this._armAbort(res, response);

        try {
            const routed = this._routeRequest(request, response);
            // dispatch has run its synchronous stretch inside _routeRequest by now, still
            // under the cork uWS holds for this callback; the await below leaves it
            response._corkNeeded = true;
            const matchedRoute = await routed;
            if (!matchedRoute && !response.headersSent && !response.aborted) {
                this._endUnmatched(request, response);
            }
        } catch (err) {
            // an internal throw answers 500 as express's final handler would, instead of
            // dying as an unhandled rejection
            if (response.aborted || response.finished) {
                console.error(err);
            } else {
                this._handleError(err, null, request, response);
            }
        }
    }

    /**
     * Binds the server and starts accepting requests.
     *
     * Returns the app and not an `http.Server`, since there is no node server underneath. The app
     * carries `address()`, `close()`, `listening` and the 'listening' and 'close' events; anything
     * needing a real server, socket.io being the usual case, wants `app.uwsApp`. The callback runs
     * on the next tick with the bind error, if there was one. A path instead of a port is a unix
     * socket.
     *
     * @param {number|string} [port] port, or a unix socket path; 0 picks a free port
     * @param {string} [host] interface to bind; every interface when omitted
     * @param {number} [backlog] accepted for node's signature; uWS sizes its own queue
     * @param {(err?: Error) => void} [callback] called once bound, or with the bind error
     * @returns {this} the app, which doubles as the server handle
     */
    listen(port, host, backlog, callback) {
        this._compileOptimizedRoutes();
        // before the catch-all: µWS sends an upgrade to the websocket route even when a
        // catch-all covers the same path, so the two coexist and the order is only tidiness
        registerWebSocketRoutes(this);
        this._createRequestHandler();
        // node's shapes: (cb), (port, cb), (port, host, cb) and (port, host, backlog, cb)
        if (typeof port === "function") {
            callback = port;
            port = 0;
        } else if (typeof host === "function") {
            callback = host;
            host = undefined;
        } else if (typeof backlog === "function") {
            callback = backlog;
        }
        // bare listen() and listen(undefined, cb) bind an OS-assigned port, as node does; left
        // undefined the port fell through to the unix-socket branch below
        if (port == null) {
            port = 0;
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
            // kept so close() can stop accepting without dropping what is in flight
            this._listenSocket = socket;
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
     * Publishes a message to every socket subscribed to a topic, from outside any of them.
     *
     * The socket's own `publish` reaches the same topics; this one is for the sender that is
     * not a socket, a timer or a route handler broadcasting to a room.
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
        // express's order, least specific first: app.locals, then res.locals riding in as _locals,
        // and what was passed to this call wins over both
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
     * Stops accepting connections, lets in-flight requests finish, then emits 'close'.
     *
     * Node's server.close(), which Express hands back from listen(), only closes the listen
     * socket and waits for what is being served; uWS's close() forcefully terminates every
     * connection, so calling it first aborted whatever a graceful shutdown was waiting for.
     * It still runs, but only once the last pending response is done, to drop the idle
     * keep-alive connections nothing else would close.
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
        if (!this.listenCalled || !wasListening) {
            // a close while a drain is underway does not emit again: the pending drain's single
            // 'close' serves both calls, which is what node does too
            if (!this._draining) {
                process.nextTick(() => this.emit("close"));
            }
            return this;
        }
        if (this._listenSocket) {
            uWS.us_listen_socket_close(this._listenSocket);
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
        // a finished response emits 'close' and unlinks itself; an aborted one only flips its
        // flags, so the drain sweeps by them. The timer also keeps the loop alive until done.
        const sweep = setInterval(() => {
            let response = this._pending.head;
            while (response !== null) {
                // taken before the unlink, which nulls the pointers
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

// An app is a function, as it is in Express, and not the Application instance whose properties it
// carries. Middleware that takes a whole app and calls it, vhost being the one everybody meets, was
// given something it could not call.
//
// This was tried once before and reverted the same day, because a callable app broke supertest:
// `request(app)` reads `typeof app === "function"` and wraps whatever it finds in
// http.createServer, and there was nothing underneath that could serve node's IncomingMessage, so
// every call timed out. src/node-shim.js is what closes that hole, and it is why this is safe now.
module.exports = function (options) {
    return new Application(options)._asCallable();
};

// the class itself, so index.js can expose its prototype as express.application does. Adding a
// method to that prototype adds it to every app, which is what the property is for.
module.exports.Application = Application;

// The demo behind fulmine-demo.fly.dev: a real Angular 22 application, server-side rendered, with
// an ordinary Express middleware stack in front of it. Everything below is the code you would write
// on Express. The only line that is not is the first one.
//
// It does not show a throughput figure. The number a shared virtual machine could produce would say
// more about the machine than about the framework, and the readme already points at benchmarks run
// by other people on hardware they describe. What it shows is that the stack runs unchanged.
import express from 'fulmine.js'; // instead of express
import { ssrCaching } from 'ng-ssr-caching';

import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import compression from 'compression';
import cors from 'cors';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';
import onHeaders from 'on-headers';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// fulmine is CommonJS and stays external to the bundle, so its package.json is read the same way
const fulmineVersion = createRequire(import.meta.url)('fulmine.js/package.json').version;

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();
const started = Date.now();
let served = 0;

// Declared here, mounted further down: it has to be registered after compression() to see the page
// before it is squeezed, but the routes above want to read its stats.
const ssrCache = ssrCaching({
  ttl: 30_000,
  staleWhileRevalidate: 60_000,
  // this demo signs nobody in, but express-session hands out a cookie to everyone, and naming it
  // here is what a real application would do with its own
  bypassCookies: [/^connect\.sid$/],
});

// Server-Timing, so the browser's own tools say how long this server took rather than the page
// claiming it. DevTools draws these under the request's timing panel, and any script on the page
// can read the same numbers through PerformanceServerTiming, which is what the demo panel shows.
//
// First in the stack, and it writes the header through on-headers rather than around next():
// everything mounted below happens inside this middleware's own call, so the number is only known
// when the response is about to go out.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  onHeaders(res, () => {
    const total = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // the cache mark rides along in the description, so one line in DevTools says both how long the
    // response took and whether it was rendered or replayed
    const mark = res.getHeader('x-ssr-cache');
    res.setHeader(
      'Server-Timing',
      `app;dur=${total.toFixed(2)};desc="Fulmine${mark ? ' ' + mark : ''}"`,
    );
  });
  next();
});

app.use(morgan('tiny'));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // Angular's build inlines the critical CSS into the document, and the tool that does it has
        // no nonce to sign it with
        'style-src': ["'self'", "'unsafe-inline'"],
        // Hydration writes two inline scripts, the event dispatch contract and its bootstrap call,
        // and Angular 22 offers no way to turn event replay off. A nonce is the proper answer and
        // is not available to us: a nonce has to be different on every request, and this page is
        // served from a cache, so the HTML and the header would carry the same one forever, which
        // is no better than what is written here and harder to read.
        'script-src': ["'self'", "'unsafe-inline'"],
        'script-src-attr': ["'unsafe-inline'"],
        // the weather comes from open-meteo, and the chat opens a socket back here
        'connect-src': ["'self'", 'https://*.open-meteo.com', 'ws:', 'wss:'],
        'img-src': ["'self'", 'data:'],
      },
    },
  }),
);
app.use(compression());
app.use(cors());
app.use(express.json());
// Mounted on /api only, and the cookie is scoped to match. A session cookie sent with the page
// request would make every page personal, which is the correct reading and would leave this cache
// permanently empty: an application that wants its SSR cached must not hand a session to a visitor
// who has not asked for one.
app.use(
  '/api',
  session({
    secret: process.env['SESSION_SECRET'] || 'a demo secret, not a real one',
    resave: false,
    saveUninitialized: true,
    cookie: { path: '/api', sameSite: 'lax' },
  }),
);
app.use((req, res, next) => {
  served++;
  next();
});

/** What this process is and how long it has been up, which is all the page needs to prove it is live. */
app.get('/api/hello', (req, res) => {
  res.json({
    message: 'Served by Fulmine on µWebSockets.js',
    fulmine: fulmineVersion,
    node: process.version,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    requestsSinceBoot: served,
    cache: ssrCache.stats(),
  });
});

/** express-session, unmodified, keeping state across requests. */
app.get('/api/visits', (req, res) => {
  const s = (req as any).session;
  s.visits = (s.visits || 0) + 1;
  res.json({ visits: s.visits, sessionId: s.id?.slice(0, 8) });
});

/** Drops the cached pages, so the panel can show a MISS being paid for and a HIT being free. */
app.post('/api/cache/purge', (req, res) => {
  res.json({ purged: ssrCache.purge() });
});

// One room per path parameter, which is app.ws() doing the two things the readme promises: the
// upgrade decides whether the socket opens, and the request stays reachable as ws.req.
app.ws('/ws/:room', {
  idleTimeout: 120,
  maxPayloadLength: 4 * 1024,
  upgrade(req: any, res: any) {
    const room = String(req.params.room);
    if (!/^[a-z0-9-]{1,24}$/.test(room)) {
      return res.sendStatus(400);
    }
    req.room = 'room:' + room;
  },
  open(ws: any) {
    ws.subscribe(ws.req.room);
    ws.send(
      JSON.stringify({
        type: 'joined',
        room: ws.req.params.room,
        people: app.numSubscribers(ws.req.room),
      }),
    );
    app.publish(
      ws.req.room,
      JSON.stringify({ type: 'people', people: app.numSubscribers(ws.req.room) }),
    );
  },
  message(ws: any, message: ArrayBuffer) {
    const text = Buffer.from(message).toString().slice(0, 500);
    if (!text.trim()) return;
    app.publish(ws.req.room, JSON.stringify({ type: 'message', text, at: Date.now() }));
  },
  close(ws: any) {
    app.publish(
      ws.req.room,
      JSON.stringify({ type: 'people', people: app.numSubscribers(ws.req.room) - 1 }),
    );
  },
});

/**
 * The built application: hashed filenames, so a year is the right answer and the browser never asks
 * for the same bundle twice.
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

// Here, and not earlier: response wrappers nest in reverse registration order, so the middleware
// registered last is the one that sees the body first. Registered before compression() this cache
// would be storing gzip and replaying it as HTML.
app.use(ssrCache);

/** The Angular handler the schematic writes, unchanged. */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT']) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`fulmine demo listening on ${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);

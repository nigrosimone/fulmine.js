'use strict';

const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

// middlewares-100 measures 100 no-ops, which no application runs. This is the stack a typical
// Express service actually mounts, at the depth it actually mounts it.
// morgan writes to a sink rather than stdout so the row measures the formatting work every request
// pays, not the runner's terminal. 'combined' is used because that is the production default, and
// it includes the remote address, which both frameworks have to resolve their own way.
module.exports = {
    name: 'middlewares/realistic-stack',
    path: '/profile',
    wrk: {
        script: 'realistic-stack.lua',
        connections: 200
    },
    // keep these in sync with realistic-stack.lua: the verify request and the load request are
    // separate definitions, so cors would otherwise be exercised only by one of them
    verify: {
        method: 'GET',
        headers: {
            'Cookie': 'sid=abc123; theme=dark',
            'Origin': 'https://example.com'
        }
    },
    setup(app, express) {
        app.use(helmet());
        app.use(cors());
        app.use(cookieParser());
        app.use(express.json());
        app.use(morgan('combined', { stream: { write: () => {} } }));

        app.get('/profile', (req, res) => {
            res.json({
                sid: req.cookies.sid || null,
                theme: req.cookies.theme || null
            });
        });
    }
};

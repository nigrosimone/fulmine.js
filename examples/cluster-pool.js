// express({ cluster: "auto" }) runs one process per core, and each of them opens its own database
// pool. app.cluster.share() splits the connections the database allows across them, so together
// the workers never open more than that.
//
//   DATABASE_URL=postgres://user:password@localhost/db node cluster-pool.js
//   curl http://localhost:3000/who   the worker, its index and its share of the connections
//   curl http://localhost:3000/now   a query through this worker's pool
const { Pool } = require("pg");
const express = require("fulmine.js"); // instead of require("express")

// what the database allows this application, all the workers together
const CONNECTIONS = 40;

const app = express({ cluster: "auto" });

// The file runs in every process. The primary only forks and serves nothing, so no pool is opened
// there: serves is false and share() is 0 (and pg would read max 0 as its default of 10)
const { workers, index, serves } = app.cluster;
const max = app.cluster.share(CONNECTIONS);
const pool = serves ? new Pool({ connectionString: process.env.DATABASE_URL, max }) : null;

app.get("/who", (req, res) => {
    // 40 over 6 workers: the first four take 7, the last two take 6
    res.json({ pid: process.pid, workers, index, connections: max });
});

app.get("/now", async (req, res) => {
    const { rows } = await pool.query("SELECT now()");
    res.json(rows[0]);
});

// With several instances (pods, machines) each running this many workers, divide by the
// instances first: share(CONNECTIONS / instances)
app.listen(3000, () => console.log(`worker ${index} of ${workers}: ${max} connections`));

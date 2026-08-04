// must support cluster
// INSPECT

const express = require("express");

const cluster = require("cluster");

express();

process.on("uncaughtException", (err) => {
    console.log({ error: err.message });
    process.exit(0);
});

const WORKERS = 2;

if (cluster.isPrimary) {
    console.log(`Master is running`);

    // Fork workers
    for (let i = 0; i < WORKERS; i++) {
        cluster.fork();
    }

    cluster.on("exit", () => {
        console.log(`Worker died`);
    });
} else {
    const app = express();

    app.listen(3000, () => {
        console.log(`Worker started`);

        setTimeout(() => {
            process.exit(0);
        }, 2000);
    });
}

// must expose the server interface that listen() returns

const express = require("express");

const app = express();

const server = app.listen(13333, "127.0.0.1", () => {
    const address = server.address();
    console.log("listening: " + server.listening);
    console.log("address: " + address.address + " " + address.family + " " + address.port);

    // registered before close(), so it runs before the close callback
    server.on("close", () => console.log("close event"));

    server.close((err) => {
        console.log("close callback error: " + err);
        console.log("listening after close: " + server.listening);
        console.log("address after close: " + server.address());

        // a default bind reports the same shape, but whether it lands on IPv6 depends on the
        // host, so only the presence of the fields is checked
        const other = express();
        const otherServer = other.listen(13334, () => {
            const shape = otherServer.address();
            console.log("default bind address is a string: " + (typeof shape.address === "string"));
            console.log("default bind family is a string: " + (typeof shape.family === "string"));

            otherServer.close(() => {
                // closing a server that is not running still calls back, with an error
                otherServer.close((secondErr) => {
                    console.log("closing twice: " + secondErr.code);
                    process.exit(0);
                });
            });
        });
    });
});

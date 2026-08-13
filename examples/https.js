// TLS is configured through express(), not through https.createServer(): there is no node server
// underneath to hand a certificate to, so the options go to uWS.
//
//   openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
//       -keyout key.pem -out cert.pem -subj "/CN=localhost"
//   node https.js
//   curl -k https://localhost:3000/
const express = require("fulmine.js"); // instead of require("express")
const path = require("path");

const app = express({
    // every field uWS's AppOptions takes, passed through as it is:
    // https://unetworking.github.io/uWebSockets.js/generated/interfaces/AppOptions.html
    uwsOptions: {
        key_file_name: process.env.TLS_KEY || path.join(__dirname, "key.pem"),
        cert_file_name: process.env.TLS_CERT || path.join(__dirname, "cert.pem")
        // passphrase, dh_params_file_name, ca_file_name and ssl_ciphers are there too
    }
});

app.get("/", (req, res) => res.json({ secure: req.secure, protocol: req.protocol }));

// the same app.listen() as ever: what it binds is decided by the options above
app.listen(3000, () => console.log("https://localhost:3000"));

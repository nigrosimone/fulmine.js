// must give an empty body the same shape express does, for every body parser

const express = require("express");

const app = express();

app.post('/json', express.json(), (req, res) => {
    res.json({ type: typeof req.body, isBuffer: Buffer.isBuffer(req.body), value: JSON.stringify(req.body) });
});

app.post('/urlencoded', express.urlencoded({ extended: false }), (req, res) => {
    res.json({ type: typeof req.body, keys: Object.keys(req.body).length });
});

app.post('/text', express.text(), (req, res) => {
    res.json({ type: typeof req.body, length: req.body.length });
});

app.post('/raw', express.raw(), (req, res) => {
    res.json({ isBuffer: Buffer.isBuffer(req.body), length: req.body.length });
});

function empty(path, contentType) {
    return fetch(`http://localhost:13333${path}`, {
        method: 'POST',
        body: '',
        headers: { 'Content-Type': contentType }
    }).then(r => r.text());
}

app.listen(13333, async () => {
    console.log('Server is running on port 13333');

    console.log(await empty('/json', 'application/json'));
    console.log(await empty('/urlencoded', 'application/x-www-form-urlencoded'));
    console.log(await empty('/text', 'text/plain'));
    console.log(await empty('/raw', 'application/octet-stream'));

    // a non-empty body must still parse the same way afterwards
    const after = await fetch('http://localhost:13333/json', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'Content-Type': 'application/json' }
    });
    console.log(await after.text());

    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(0);
});

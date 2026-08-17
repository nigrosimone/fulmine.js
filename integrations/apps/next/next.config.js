const path = require("node:path");

// A custom server takes the request handler, so there is nothing to configure but the noise.
// turbopack.root is the integrations directory, which is where node_modules is: without it Next
// picks between two lockfiles and warns about the ambiguity on every start, naming absolute paths
// that differ per machine, and pointing it at this directory instead cuts it off from node_modules.
module.exports = {
    turbopack: { root: path.join(__dirname, "..", "..") }
};

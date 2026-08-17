import adapter from "@sveltejs/adapter-node";

// the node adapter, whose build/handler.js is an express-shaped middleware. That handler is what
// the case mounts, and the whole reason this app exists
export default { kit: { adapter: adapter() } };

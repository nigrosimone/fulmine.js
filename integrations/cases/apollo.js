// Apollo Server through @as-integrations/express5: the GraphQL middleware mounted on the app.
//
// It reads the body off the request as any Express middleware does, writes with res.send, and sets
// its own headers, so what is being compared here is the request and response surface under a
// middleware nobody in this project wrote.

const { ApolloServer } = require("@apollo/server");
const { expressMiddleware } = require("@as-integrations/express5");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13802;

const typeDefs = `#graphql
    type Item {
        id: Int!
        name: String!
    }
    type Query {
        item(id: Int!): Item
        items: [Item!]!
    }
    type Mutation {
        rename(id: Int!, name: String!): Item!
    }
`;

const items = [
    { id: 1, name: "primo" },
    { id: 2, name: "secondo" }
];

const resolvers = {
    Query: {
        /** @returns {object|null} */
        item: (/** @type {any} */ _parent, /** @type {any} */ args) => items.find((one) => one.id === args.id) ?? null,
        /** @returns {object[]} */
        items: () => items
    },
    Mutation: {
        /** @returns {object} */
        rename: (/** @type {any} */ _parent, /** @type {any} */ args) => {
            const found = items.find((one) => one.id === args.id);
            if (!found) throw new Error(`no item ${args.id}`);
            found.name = args.name;
            return found;
        }
    }
};

/** Posts a GraphQL document and prints what came back. */
function post(query, variables) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, variables })
        });
        console.log(await response.text());
    };
}

/** Mounts Apollo on this arm's app and asks it a few questions. */
async function main() {
    const app = express();
    // the stack in an error body names absolute paths and its async frames differ run to run, so
    // it is not something two arms could ever be compared on
    const server = new ApolloServer({ typeDefs, resolvers, includeStacktraceInErrorResponses: false });
    await server.start();
    app.use("/graphql", express.json(), expressMiddleware(server));
    app.listen(PORT, async () => {
        await sequential([
            post("query { items { id name } }"),
            post("query One($id: Int!) { item(id: $id) { id name } }", { id: 2 }),
            post("query One($id: Int!) { item(id: $id) { id name } }", { id: 99 }),
            // a field that is not in the schema: Apollo answers 400 with its own error shape
            post("query { items { id colour } }"),
            post("mutation Rename($id: Int!, $name: String!) { rename(id: $id, name: $name) { id name } }", {
                id: 1,
                name: "rinominato"
            }),
            // not JSON, so the middleware refuses before any resolver runs
            async () => {
                const response = await fetchTest(`http://localhost:${PORT}/graphql`, {
                    method: "POST",
                    headers: { "content-type": "text/plain" },
                    body: "{ items { id } }"
                });
                console.log(await response.text());
            },
            // the GET path: the document comes off the query string, and the preflight header is
            // what gets it past Apollo's CSRF guard
            async () => {
                const query = encodeURIComponent("query { items { id name } }");
                const response = await fetchTest(`http://localhost:${PORT}/graphql?query=${query}`, {
                    headers: { "apollo-require-preflight": "true" }
                });
                console.log(await response.text());
            },
            // GET with nothing to run, which the middleware refuses
            async () => {
                const response = await fetchTest(`http://localhost:${PORT}/graphql`, {
                    headers: { "apollo-require-preflight": "true" }
                });
                console.log(await response.text());
            }
        ]);
        await server.stop();
        process.exit(0);
    });
}

main();

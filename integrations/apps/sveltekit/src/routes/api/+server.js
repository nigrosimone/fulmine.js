import { error, json } from "@sveltejs/kit";

/** a GET reading the query string */
export function GET({ url }) {
    if (url.searchParams.get("tag") === "boom") {
        // SvelteKit's own error, so the body is its error shape and carries no stack
        error(418, "no tea here");
    }
    return json({ tag: url.searchParams.get("tag") ?? null });
}

/** a POST reading a JSON body, which the handler parses itself rather than through a middleware */
export async function POST({ request }) {
    let body;
    try {
        body = await request.json();
    } catch {
        // caught here rather than left to throw: an unhandled one makes SvelteKit log a node
        // internal stack, and a stack is not something two arms should be compared on
        error(400, "not json");
    }
    return json({ received: body, keys: Object.keys(body ?? {}).sort() }, { status: 201 });
}

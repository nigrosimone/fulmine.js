export const prerender = false;

/** a GET reading the query string */
export function GET({ url }) {
    const tag = url.searchParams.get("tag");
    if (tag === "boom") {
        return new Response(JSON.stringify({ error: "no tea here" }), {
            status: 418,
            headers: { "content-type": "application/json" }
        });
    }
    return Response.json({ tag: tag ?? null });
}

/** a POST reading a JSON body, parsed by the handler rather than by a middleware */
export async function POST({ request }) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "not json" }, { status: 400 });
    }
    return Response.json({ received: body, keys: Object.keys(body ?? {}).sort() }, { status: 201 });
}

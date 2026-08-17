export const dynamic = "force-dynamic";

/** a GET reading the query string */
export function GET(request) {
    const tag = new URL(request.url).searchParams.get("tag");
    if (tag === "boom") {
        return Response.json({ error: "no tea here" }, { status: 418 });
    }
    return Response.json({ tag: tag ?? null });
}

/** a POST reading a JSON body, parsed by the route rather than by a middleware */
export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "not json" }, { status: 400 });
    }
    return Response.json({ received: body, keys: Object.keys(body ?? {}).sort() }, { status: 201 });
}

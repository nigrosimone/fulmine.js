// The controller the tsoa case serves. Small on purpose: a list with a query, a path parameter
// that can miss, a body tsoa validates, and a status set by hand.

import { Body, Controller, Get, Header, Path, Post, Query, Route, SuccessResponse } from "tsoa";

interface Item {
    id: number;
    name: string;
}

interface NewItem {
    /** @minLength 1 */
    name: string;
}

const items = new Map<number, string>([
    [1, "primo"],
    [2, "secondo"]
]);

class NotFound extends Error {
    status = 404;
}

@Route("items")
export class ItemsController extends Controller {
    @Get()
    public list(@Query() prefix?: string): Item[] {
        return [...items]
            .filter(([, name]) => prefix === undefined || name.startsWith(prefix))
            .map(([id, name]) => ({ id, name }));
    }

    @Get("{id}")
    public byId(@Path() id: number, @Header("x-trace") trace?: string): Item {
        const name = items.get(id);
        if (name === undefined) throw new NotFound(`no item ${id}`);
        if (trace) this.setHeader("x-trace", trace);
        return { id, name };
    }

    @SuccessResponse("201", "Created")
    @Post()
    public create(@Body() body: NewItem): Item {
        const id = Math.max(0, ...items.keys()) + 1;
        items.set(id, body.name);
        this.setStatus(201);
        return { id, name: body.name };
    }
}

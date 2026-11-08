// The controller the Ts.ED case serves: a list with a query, a path parameter converted to a number
// that can miss, a body validated by ajv, a form, a text body and a status set by hand.

import { Controller } from "@tsed/di";
import { NotFound } from "@tsed/exceptions";
import { BodyParams, HeaderParams, PathParams, QueryParams } from "@tsed/platform-params";
import { Get, MinLength, Post, Property, Required, Returns } from "@tsed/schema";

export class NewItem {
    @Required()
    @MinLength(1)
    name: string;

    @Property()
    color?: string;
}

const items = new Map<number, string>([
    [1, "primo"],
    [2, "secondo"]
]);

@Controller("/items")
export class ItemsController {
    @Get("/")
    list(@QueryParams("prefix") prefix?: string) {
        return [...items]
            .filter(([, name]) => prefix === undefined || name.startsWith(prefix))
            .map(([id, name]) => ({ id, name }));
    }

    @Get("/:id")
    byId(@PathParams("id") id: number, @HeaderParams("x-trace") trace?: string) {
        const name = items.get(id);
        if (name === undefined) throw new NotFound(`no item ${id}`);
        return { id, name, kind: typeof id, trace: trace ?? null };
    }

    @Post("/")
    @Returns(201)
    create(@BodyParams() body: NewItem) {
        const id = Math.max(0, ...items.keys()) + 1;
        items.set(id, body.name);
        return { id, name: body.name, color: body.color ?? null };
    }

    @Post("/form")
    form(@BodyParams() body: Record<string, unknown>) {
        return { received: body, keys: Object.keys(body).sort() };
    }

    @Post("/text")
    text(@BodyParams() body: string) {
        return { length: body.length, upper: body.toUpperCase() };
    }
}

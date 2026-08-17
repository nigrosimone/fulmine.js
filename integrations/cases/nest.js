// NestJS through @nestjs/platform-express: a controller, a pipe, a body and an exception filter,
// answering the same bytes on both arms.
//
// The decorators are applied by hand because this suite has no TypeScript build and a decorator is
// only a function. What it costs is four lines per route; what it saves is a compiler in the way of
// a test whose subject is the adapter.

require("reflect-metadata");
const {
    Module,
    Controller,
    Get,
    Post,
    Param,
    Body,
    Query,
    ParseIntPipe,
    HttpCode,
    NotFoundException
} = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { nestAdapter } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13801;

/**
 * Applies a method decorator the way the TypeScript emit would, descriptor included.
 *
 * @param {Function} target the class
 * @param {string} key the method
 * @param {Function} decorator what `@Get()` and friends return
 * @returns {void}
 */
function method(target, key, decorator) {
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(target.prototype, key));
    decorator(target.prototype, key, descriptor);
    Object.defineProperty(target.prototype, key, descriptor);
}

/**
 * Applies a parameter decorator, which takes the position rather than a descriptor.
 *
 * @param {Function} target the class
 * @param {string} key the method
 * @param {number} index which argument
 * @param {Function} decorator what `@Param()` and friends return
 * @returns {void}
 */
function param(target, key, index, decorator) {
    decorator(target.prototype, key, index);
}

class ItemsController {
    /** @returns {string} a plain string, which Nest sends as text/html */
    hello() {
        return "hello from nest";
    }

    /**
     * @param {number} id through ParseIntPipe, so a non-numeric one is a 400 from Nest itself
     * @param {string} [tag] from the query string
     * @returns {object}
     */
    one(id, tag) {
        if (id === 404) {
            throw new NotFoundException(`no item ${id}`);
        }
        return { id, tag: tag ?? null, kind: typeof id };
    }

    /**
     * @param {any} body parsed by the body parser Nest registers
     * @returns {object}
     */
    create(body) {
        return { received: body, keys: Object.keys(body ?? {}).sort() };
    }
}

param(ItemsController, "one", 0, Param("id", ParseIntPipe));
param(ItemsController, "one", 1, Query("tag"));
param(ItemsController, "create", 0, Body());
method(ItemsController, "hello", Get());
method(ItemsController, "one", Get(":id"));
method(ItemsController, "create", Post());
method(ItemsController, "create", HttpCode(201));
Controller("items")(ItemsController);

class AppModule {}
Module({ controllers: [ItemsController] })(AppModule);

/** Serves the module on this arm's adapter and sends the same requests to it. */
async function main() {
    const app = await NestFactory.create(AppModule, nestAdapter(), { logger: false });
    await app.listen(PORT);

    const base = `http://localhost:${PORT}/items`;
    await sequential([
        async () => console.log(await (await fetchTest(base)).text()),
        async () => console.log(await (await fetchTest(`${base}/7?tag=blue`)).text()),
        async () => console.log(await (await fetchTest(`${base}/404`)).text()),
        async () => console.log(await (await fetchTest(`${base}/nope`)).text()),
        async () =>
            console.log(
                await (
                    await fetchTest(base, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ b: 2, a: 1 })
                    })
                ).text()
            ),
        async () =>
            console.log(
                await (
                    await fetchTest(base, {
                        method: "POST",
                        headers: { "content-type": "application/x-www-form-urlencoded" },
                        body: "name=simone&city=napoli"
                    })
                ).text()
            ),
        // no route: Nest's own 404, which is the adapter's not-found handler rather than Express's
        async () => console.log(await (await fetchTest(`http://localhost:${PORT}/missing`)).text())
    ]);

    await app.close();
    process.exit(0);
}

main();

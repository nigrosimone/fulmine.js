// Which framework the case being run is served by.
//
// A case is one file, run twice: once with Express and once with Fulmine, and the two runs have to
// print the same bytes. Same idea as the comparison suite in tests/, and a separate directory only
// because these dependencies are frameworks rather than middlewares: they are heavy, they are not
// what `npm test` gates on, and nobody should have to install Nest to run the test suite.

const arm = process.env.INTEGRATION_ARM;

if (arm !== "express" && arm !== "fulmine") {
    throw new Error("INTEGRATION_ARM must be express or fulmine; run these through run.js");
}

/** The framework this arm serves with. Both are Express 5, one of them is this project. */
const express = arm === "fulmine" ? require("fulmine.js") : require("express");

/**
 * The Nest HTTP adapter for this arm.
 *
 * The Fulmine arm is the whole point of the exercise: `fulmine.js/nest` is what a Nest application
 * has to use to be served by µWS rather than through a node server wrapping it.
 *
 * @returns {any}
 */
function nestAdapter() {
    if (arm === "fulmine") {
        const { FulmineExpressAdapter } = require("fulmine.js/nest");
        return new FulmineExpressAdapter();
    }
    const { ExpressAdapter } = require("@nestjs/platform-express");
    return new ExpressAdapter();
}

/**
 * The Ts.ED platform for this arm: `@tsed/platform-fulmine` on the Fulmine arm, which is the thing
 * being tested, and Ts.ED's own Express platform on the other. Ts.ED is ESM only, hence the import.
 *
 * @returns {Promise<any>} the platform class, with `bootstrap(Server, settings)`
 */
async function tsedPlatform() {
    if (arm === "fulmine") {
        return (await import("@tsed/platform-fulmine")).PlatformFulmine;
    }
    return (await import("@tsed/platform-express")).PlatformExpress;
}

module.exports = { arm, express, nestAdapter, tsedPlatform };

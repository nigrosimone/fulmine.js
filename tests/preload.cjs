process.exit;
process.exit = /** @type {typeof process.exit} */ (
    (...args) => {
        console.log("process.exit", ...args);
        // _processExit(...args);
    }
);

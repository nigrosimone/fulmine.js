process.exit;
process.exit = (...args) => {
    console.log("process.exit", ...args);
    // _processExit(...args);
};

// Node 24 and later crash on Windows when process.exit() runs while undici still has
// keep-alive sockets open: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// file src\win\async.c" (nodejs/node#56645). Every test here ends with process.exit()
// right after fetching, so they hit it, and the crash also loses whatever stdout was
// still buffered, which makes the captured output unreliable on top of the exit code.
//
// Letting the loop settle first avoids it. Preloaded by tests/index.js on win32 only,
// so nothing changes on Linux or macOS.

const EXIT_DELAY_MS = 100;

const realExit = process.exit.bind(process);

// the cast, because process.exit is typed as never-returning and this replacement returns
process.exit = /** @type {any} */ (
    (code) => {
        if (code !== undefined) {
            process.exitCode = code;
        }
        setTimeout(() => realExit(process.exitCode), EXIT_DELAY_MS);
    }
);

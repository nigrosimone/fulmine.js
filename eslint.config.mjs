import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
    {
        ignores: ["node_modules/**", "coverage/**", ".nyc_output/**", "benchmark/assets/**", "src/types.d.ts"]
    },
    js.configs.recommended,
    {
        files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: {
                ...globals.node
            }
        },
        rules: {
            // the codebase leans on hoisting and on catch parameters it does not always read
            "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
            eqeqeq: ["warn", "smart"],
            "no-var": "error",
            "prefer-const": ["warn", { destructuring: "all" }],
            "no-console": "off",
            // several getters return undefined on purpose when there is nothing to report
            "getter-return": ["error", { allowImplicit: true }],
            // a blank line between class members. Prettier keeps a blank line that is already
            // there but never adds one, so this is the rule that puts it there, and --fix does it
            "lines-between-class-members": ["error", "always", { exceptAfterSingleLine: false }]
        }
    },
    {
        files: ["eslint.config.mjs"],
        languageOptions: {
            sourceType: "module"
        }
    },
    {
        // test files are fixtures whose only contract is the stdout they produce, and the runner
        // rewrites them on every run. an unread `await fetch(...)` result or a redundant escape is
        // not worth churning them over, so these stay visible as warnings rather than blocking lint
        files: ["tests/**/*.js", "tests/**/*.cjs"],
        rules: {
            "no-unused-vars": "warn",
            "no-useless-assignment": "warn",
            "no-useless-escape": "warn",
            "no-unreachable": "warn",
            "no-useless-catch": "warn"
        }
    },
    // formatting is prettier's job; this turns off every rule that would argue with it
    prettier
];

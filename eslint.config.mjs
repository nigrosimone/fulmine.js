import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";

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
        // Every method in src/ carries a JSDoc block as of 2026-08-02, and this is what keeps it
        // that way: 54 of the 110 were undocumented and nothing was stopping the count from
        // climbing again. Only src/, and only members, since a block on every arrow function in
        // the test fixtures would be noise rather than documentation.
        files: ["src/**/*.js"],
        plugins: { jsdoc },
        rules: {
            "jsdoc/require-jsdoc": [
                "error",
                {
                    require: { MethodDefinition: true, FunctionDeclaration: true },
                    // a getter and its setter are one thing to explain, and the block goes on the
                    // getter, so the setter is not asked for one of its own
                    checkGetters: true,
                    checkSetters: false,
                    contexts: []
                }
            ],
            // the tags that are there have to be true. A renamed parameter whose @param still says
            // the old name is worse than no @param at all, and neither the type checker nor a
            // reader would catch it
            "jsdoc/check-param-names": "error",
            // not { typed: true }: that setting is for TypeScript sources, where @type and @this
            // would indeed be saying twice what the syntax already says. Here they are the only
            // way to say it, and the type checker reads them
            "jsdoc/check-tag-names": "error",
            "jsdoc/no-undefined-types": "off",
            // not required, because a good many of these methods are better explained in prose
            // than by listing arguments whose names already say what they are
            "jsdoc/require-param": "off",
            "jsdoc/require-returns": "off"
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

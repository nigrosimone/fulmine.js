import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import sonarjs from "eslint-plugin-sonarjs";

export default [
    {
        ignores: [
            "node_modules/**",
            "coverage/**",
            ".nyc_output/**",
            "benchmark/assets/**",
            "src/types.d.ts",
            // the applications the integration cases serve, and what their builds write. Each one
            // is somebody else's framework with its own conventions, modules and JSX included, and
            // teaching this config four dialects to lint four fixtures is not worth it
            "integrations/apps/**"
        ]
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
            eqeqeq: ["error", "smart"],
            "no-var": "error",
            "prefer-const": ["error", { destructuring: "all" }],
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
                    contexts: ["PropertyDefinition"]
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
        // Adopted 2026-09-08, only src/. The recommended set minus the rules below: those fire on
        // things this codebase does on purpose, and a rule nobody may act on is worse than no rule.
        // The count each one was carrying when it was turned off is written next to it, so a later
        // reader can see what turning it back on would cost.
        files: ["src/**/*.js"],
        plugins: { sonarjs },
        rules: {
            ...sonarjs.configs.recommended.rules,
            // 49. The request path is deliberately long and flat: splitting it is what the speed
            // rule in CONTRIBUTING forbids, so this rule and this project disagree by design
            "sonarjs/cognitive-complexity": "off",
            // 16. `x ?? (x = ...)` is the memoization idiom used throughout, see statusLine
            "sonarjs/no-nested-assignment": "off",
            // 16 and 7, both style, and prettier already decides how these are laid out
            "sonarjs/no-nested-conditional": "off",
            "sonarjs/no-nested-template-literals": "off",
            // 6. This parses HTTP: control characters are the subject, not an accident
            "sonarjs/no-control-regex": "off",
            // 3, style
            "sonarjs/no-inverted-boolean-check": "off",
            // 1, a false positive: compression.js probes a stateful stream twice on purpose, and
            // the two calls are identical because that is the test
            "sonarjs/no-identical-expressions": "off",
            // 1, a false positive: /\/+$/ in router.js is express's own regex, character for
            // character, and the paths it runs on are written by the developer, not received
            "sonarjs/super-linear-regex": "off",
            // one site each, left off until someone decides whether to change the site or the rule:
            // no-empty-group and void-use in utils.js, no-ignored-exceptions in declarative.js,
            // no-invariant-returns in response.js, no-nested-functions in middlewares.js,
            // pseudo-random and no-hardcoded-ip in application.js
            "sonarjs/no-empty-group": "off",
            "sonarjs/void-use": "off",
            "sonarjs/no-ignored-exceptions": "off",
            "sonarjs/no-invariant-returns": "off",
            "sonarjs/no-nested-functions": "off",
            "sonarjs/pseudo-random": "off",
            "sonarjs/no-hardcoded-ip": "off"
        }
    },
    {
        files: ["eslint.config.mjs"],
        languageOptions: {
            sourceType: "module"
        }
    },
    {
        // test files are fixtures whose only contract is the stdout they produce, so a rule that
        // would change what one prints is off rather than lowered to a warning. Nothing here is a
        // warning: a warning is a thing nobody fixes
        files: ["tests/**/*.js", "tests/**/*.cjs"],
        rules: {
            "no-useless-catch": "off"
        }
    },
    // formatting is prettier's job; this turns off every rule that would argue with it
    prettier
];

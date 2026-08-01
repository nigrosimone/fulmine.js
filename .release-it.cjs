// The major number here is not a semver signal, it is a compatibility marker: it says which
// Express major this tracks. 5.x follows Express 5. If Express 6 arrives, this goes to 6.
//
// So the major is never derived from the commits. `npm run release` and the Release workflow both
// pick between patch and minor on their own; a major only ever happens when someone writes the
// number out, either as `npx release-it 6.0.0` or through the workflow's `version` input.
//
// Breaking changes are still written as breaking changes, with `!` or a BREAKING CHANGE footer,
// and they still appear in the changelog under their own heading. They just do not move the major
// by themselves. That is a deliberate departure from semver and it is documented in the README,
// because it changes what the number promises to anyone installing this.

// whatBump below closes the automatic door. This closes the other one: `release-it major` bumps
// by keyword, which skips the recommendation entirely and would land on the major after this one
// rather than the Express major. Raising it means writing the number out.
if (process.argv.slice(2).includes("major")) {
    // written straight to stderr because release-it rewrites anything thrown from here as
    // "Invalid configuration file", which would send someone looking in the wrong place
    process.stderr.write(
        "\nThe major tracks the Express major and is never bumped by keyword.\n" +
            "Pass the version instead, for example: npx release-it 6.0.0\n\n"
    );
    throw new Error("refusing a keyword major bump");
}

// conventional-recommended-bump speaks in levels: 0 is major, 1 is minor, 2 is patch.
const MAJOR = 0;
const MINOR = 1;
const PATCH = 2;

module.exports = {
    git: {
        commitMessage: "chore(release): ${version}",
        tagName: "v${version}",
        tagAnnotation: "Release ${version}"
    },
    npm: {
        publish: false
    },
    github: {
        release: false
    },
    plugins: {
        "@release-it/conventional-changelog": {
            preset: {
                name: "conventionalcommits"
            },
            infile: "CHANGELOG.md",
            whatBump(commits) {
                const breaking = commits.filter((commit) => commit.notes && commit.notes.length > 0).length;
                const features = commits.filter((commit) => commit.type === "feat").length;

                if (breaking > 0) {
                    return {
                        level: MINOR,
                        reason:
                            `${breaking} breaking change(s), released as a minor. The major tracks the ` +
                            `Express major and is only ever set by hand, so pass a version explicitly ` +
                            `if this should raise it.`
                    };
                }

                if (features > 0) {
                    return { level: MINOR, reason: `${features} feature(s)` };
                }

                return { level: PATCH, reason: "fixes and maintenance only" };
            }
        }
    }
};

// exported for the test below and to keep the levels honest if this is ever refactored
module.exports.LEVELS = { MAJOR, MINOR, PATCH };

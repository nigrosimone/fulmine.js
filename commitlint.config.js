// Conventional commits, because the release notes and the version bump are both derived from
// them. A message that does not parse means a release that silently misses a change.
//
// Note what the major number means here: see .release-it.cjs. A breaking change is still written
// as one, with `!` or a BREAKING CHANGE footer, and it still shows up in the changelog. It just
// does not decide the major on its own.
module.exports = {
    extends: ["@commitlint/config-conventional"],
    rules: {
        // the default 100 is tight for a subject that has to say what changed and why
        "header-max-length": [2, "always", 120],
        // the body carries the reasoning, and it is worth room to breathe
        "body-max-line-length": [2, "always", 100]
    }
};

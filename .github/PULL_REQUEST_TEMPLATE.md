## What this changes

<!-- One paragraph. If it fixes a divergence from Express, say what Express does. -->

## Checklist

- [ ] `npm test` passes (the comparison suite runs every test against real Express and against fulmine, and the outputs must match)
- [ ] `npm run test:unit` passes
- [ ] `npm run lint` and `npm run format:check` are clean
- [ ] a behaviour change comes with a comparison test in `tests/tests/`
- [ ] a change touching the request path was measured: `npm run benchmark:ab -- --against main --scenario <one that exercises it>`, and the result is quoted in the description (the null control too, if the move is small)

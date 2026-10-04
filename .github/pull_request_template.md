## What and why

<!-- The problem first. Several decisions here look wrong without the measurement that forced
     them, so if this change is driven by something you observed, say what you observed. -->

## Checklist

- [ ] `npm test` passes
- [ ] No npm dependency added
- [ ] Generated files regenerated if their source changed — `npm run gen:schema`,
      `npm run docs:config`, `npm run docs:env`, `npm run sync:version`, `npm run evals:build`
- [ ] A new branch in `decide()` has a fail-open test
- [ ] A changed threshold or glob default has a negative eval proving the refusals still hold
- [ ] A new environment variable is declared in `SPEC` or `lib/env-registry.mjs`
- [ ] A new setting has a description in `lib/config-descriptions.mjs`
- [ ] A new npm script or public command is documented
- [ ] No guessed number where `null` is the truth

## Defaults

- [ ] This changes no routing, governance, provider or worker-model default
- [ ] ...or it does, and the reason is above

# Plan

## Next

- 0002-trim-names: Ignore surrounding whitespace in names.
  - Scope: `src/greet.js`, `test/greet.test.js`.
  - Trim the supplied name before constructing the greeting; preserve letter case.
  - Accept: `greet("  Ada  ")` returns `"Hello, Ada!"`; existing greetings still pass.
  - Validate: `npm run check`, `npm test`.

- 0003-empty-name-default: Use the default greeting for empty names.
  - Depends on `0002-trim-names`.
  - Scope: `src/greet.js`, `test/greet.test.js`.
  - Treat empty and whitespace-only names as `"world"` after trimming.
  - Accept: `greet("")` and `greet("   ")` return `"Hello, world!"`.
  - Validate: `npm run check`, `npm test`.

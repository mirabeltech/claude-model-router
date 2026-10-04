Three declarations are exported from this file:

- parseManifest, a function that parses a manifest string
- MANIFEST_VERSION, a constant
- ManifestWriter, a class with a write method

Each export sits at the top level. The remaining lines are bundled output and export nothing.

The first of the three reads:

```ts
export function parseManifest(input) { return JSON.parse(input) }
```

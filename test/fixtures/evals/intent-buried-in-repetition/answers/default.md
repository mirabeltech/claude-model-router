The handler x_137 is the only entry marked deprecated. It is declared on line 140 of
files/handlers.ts:

```ts
registerHandler('x_137', { retries: 2, deprecated: true })
```

Every other registration omits the flag and differs only in its retries value.

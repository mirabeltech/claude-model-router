files/dispatch.ts defines resolveWorker, which returns an object carrying a provider field.

files/telemetry.ts defines buildEvent and files/globs.ts defines matchesGlob. Neither of
those two declares resolveWorker.

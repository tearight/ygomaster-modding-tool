# Modding tool checkout instructions

This editor is an adapter for the current YgoMaster Solo contract; its legacy types are not authoritative.

- Read `../../docs/COMPATIBILITY.md` and `../../TASKS.md` before implementation.
- Never run import/export against `../YgoMaster/YgoMaster/Data`, a real game directory, or the user's only copy. Use `../../campaign/fixtures` or a disposable directory under `../../campaign/generated`.
- First preserve raw and `code`/`res`-wrapped payloads plus unknown fields. Do not narrow current data to the v0.12.2 model during a round trip.
- Separate Solo conversion from Shop/Settings mutation and from deployment.
- Prefer pure conversion and validation modules callable without Electron; add golden fixture tests for every schema change.
- Do not run `npm audit fix` or broad dependency upgrades as part of an unrelated compatibility change.
- After changes run `npm run type-check`, `npm run lint`, and the relevant fixture tests. Review generated semantic diffs before reporting completion.
- Keep generated files, package output, logs, and game data out of commits.

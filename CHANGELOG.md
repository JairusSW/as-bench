## Unreleased

- Scaffold the three build targets (`cli/`→`bin/`, `lib/`→`lib/build/`, `transform/src/`→`transform/lib/`) mirroring as-test.
- Thin runtime-agnostic host (`lib/as-bs.ts`): `instantiate()` for node bindings + WASI, live `now()`, default imports.
- CLI skeleton (`as-bench` / `asb`): `help`/`version` wired; `run`/`profile`/`build`/`init` stubbed.
- AssemblyScript API skeleton (`bench`, `suite`, `set`, `blackbox`) + descriptors/settings; no `run()` — bench files execute at module start (as-tral style).
- No-op `asc` transform plugin skeleton.
- Project plan in `PLAN.md`.

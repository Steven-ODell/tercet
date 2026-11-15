# Changelog

## Unreleased

- settings: a key tercet does not know no longer stops startup. It is ignored and `tercet doctor`
  lists it with its line, so a settings file from a newer build still opens in an older one.
  Wrong types and values still stop startup.
- read aloud: `tercet readback setup` installs Kokoro into tercet's own data directory (asks first,
  about 354 MB, checks SHA-256) and `tercet readback status` reports what is missing. Without it,
  **[read]** says "Read aloud is not set up. Run `tercet readback setup`." and `tercet doctor` has
  a `read aloud` row. New `readback.home` setting; `KOKORO_HOME` and `KOKORO_PYTHON` still work.
  The old default of `~/Projects/Side/kokoro` is gone: set `readback.home` or `KOKORO_HOME` to
  keep using a setup you already have.

## tercet 0.1.0 (2026-11-12)

Works with T3 Code servers >=0.1.8 <0.2.0, tested on 0.1.8.

Changes:

- harden: remote images, token scope, flag errors (f011eb3)
- compat: gate on protocol, warn on version (6207b68)
- p10: gate 2 fixes (793d8bc)
- tercet: a terminal client for T3 Code (97844ef)

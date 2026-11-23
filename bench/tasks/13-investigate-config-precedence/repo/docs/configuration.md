# Configuration precedence

Sources merge in this order, later wins:

1. `src/sources/defaults.ts`
2. the JSON file named by `CONF_FILE` (default `conf.json`)
3. the environment (`CONF_HTTP_PORT`, `CONF_DB_URL`, `CONF_FLAGS`, ...)
4. command line flags (`--port`, `--host`)

After all four sources have merged, `src/resolve.ts` applies a profile overlay
when `CONF_PROFILE` names a profile other than `base`. `CONF_NO_PROFILE=1`
skips the overlay. Profiles live in `src/profiles/`.

List values (`features.flags`) are concatenated across sources rather than
replaced.

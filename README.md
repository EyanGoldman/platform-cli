# Platform CLI

The bootstrap CLI that gets a developer machine from "nothing installed" to
"ready to build apps via Claude Code" against the enterprise platform proxy.

This repository holds three pieces:

- **`platform-cli/`** — the `platform` binary (login, doctor, refresh, new).
  Reads platform proxy URLs from env, mints a developer git token via SSO,
  and pre-configures the developer's machine (git credential helper,
  marketplace registration, `~/.platform/env`).
- **`platform-cred-helper/`** — a git credential-helper plugin
  (`platform-cred-helper.mjs`) that returns the developer git token to git
  for any HTTPS request to the configured platform host.
- **`install/`** — the bootstrap shell scripts (`install.sh`, `install.ps1`)
  that download + install all of the above on a fresh machine.

## Releases

Pushes to `main` build all artifacts and publish a rolling release tagged
`platform-cli-latest`:

- `platform-cli-latest.tgz` — the CLI as an npm-pack tarball
- `platform-cred-helper.tgz` — the cred-helper script + package.json
- `install.sh` / `install.ps1` — the install scripts (with placeholder
  `__PLATFORM_PROXY_BASE_URL__` un-templated; the platform's app-store
  templates this at serve time)

End users get the templated installer from their platform's app-store:

```
curl -fsSL https://app-store.<your-platform>.com/install.sh | sh
```

## Local development

The packages here have no `@enterprise/*` workspace dependencies — they're
standalone Node packages. Each has its own `package.json`, build scripts,
and tests.

```bash
cd platform-cli
pnpm install
pnpm build
pnpm test
```

## License

MIT — see [LICENSE](LICENSE).

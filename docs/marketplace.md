# Publishing to a dsh plugin market

[← README](../README.md)

dsh has **no central marketplace and ships no index source**. A plugin market is just a JSON index (format 1) at an https URL. Users add that URL under **Plugins → Discover → Add index source**, after turning on the experimental **Custom plugin indexes** bundle (named *Custom plugin markets* before 0.2.2-alpha.2). The official guide is at <https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market>.

There are three ways for users to find this plugin. They do not depend on each other.

## A. Direct install (works today, no market needed)

```bash
dsh plugin --profile web add "git+https://github.com/hsliuustc0106/dsh-jiuwen-adapter.git#1fe6a0e7bff9a6bb965271e95c707c49c279eff5"
```

On 2026-10-30 (UTC+8) this was checked with dsh 0.2.1-rc.5 in a throwaway `DSH_HOME`. It installed one package and no dependencies, and dsh added `@dsh-jiuwen/adapter` to the profile's `bundles`.

## B. Our own index (ready, only needs hosting)

`market/index.json` and `market/icon.svg` are produced by `npm run market:index`. The script uses `package.json` as the source of truth, pins the git source to a full commit, and checks the result with the official `@deepseek-ai/dsh-plugin-market-index` parser. That check passes with both the dsh 0.2.1-rc.2 and rc.5 parsers.

Because this repo is public, the index can be used straight from GitHub. dsh does not follow redirects, so use this exact URL:

```
https://raw.githubusercontent.com/hsliuustc0106/dsh-jiuwen-adapter/main/market/index.json
```

You can also set it in a profile's `cordis.patch.yml`:

```yaml
- id: plugin-market
  name: '@deepseek-ai/dsh-plugin-market'
  config:
    indexes:
      - https://raw.githubusercontent.com/hsliuustc0106/dsh-jiuwen-adapter/main/market/index.json
```

For a release: bump the version, commit, run `npm run market:index` (this pins HEAD), then commit `market/`.

## C. Third-party registry: dsh.so

[dsh.so](https://www.dsh.so) is a community registry that publishes its own index (`https://cdn.dsh.so/market/index.json`) of plugins that passed its sandbox install test and a security scan. It finds repos tagged with the **`dsh-plugin`** GitHub topic automatically, and it also takes submissions at <https://www.dsh.so/submit/>.

This repo already meets its acceptance criteria:
- a `dsh` field in package.json
- a README with install instructions
- an SPDX license (Apache-2.0)
- a slug-safe repo name
- scannable JS source
- no hardcoded secrets

The only placeholder is `sk-xxxx` in docs/quickstart.md, which may draw a warning and need review.

## Optional: npm

After `npm publish`, users can run `dsh plugin add @dsh-jiuwen/adapter`, and the index can switch to `npm run market:index -- --source npm`.

`npm pack --dry-run` is clean: 47 files, about 141 kB, with no logs, PNGs or profiles.

Publishing needs:
- an npm account that owns the `@dsh-jiuwen` scope (or a rename to an unscoped name)
- `npm login`
- `npm publish`, which runs with `publishConfig.access=public`

# Contributing to secretgenerator

Thanks for considering a contribution. This project's audit story depends on
every change passing through the same gates.

## Development setup

```sh
git clone https://github.com/rafaelperoco/secretgenerator
cd secretgenerator
go build ./...
go test ./...
```

You will need:

- Go 1.23 or later
- `golangci-lint` v2.0.2+ (matched in CI)
- `goreleaser` v2 (only for release validation)

## Required status checks

The following must pass on every PR before merge:

| Check                 | Command                                                    |
| --------------------- | ---------------------------------------------------------- |
| Unit + integration    | `go test -race ./...`                                      |
| E2E                   | `go test -race ./test/e2e/...`                             |
| Coverage ≥ 90%        | `go test -coverpkg=./internal/...,./cmd/... ./...`         |
| Statistical (release) | `go test -tags stats -run ChiSquared ./internal/generator` |
| Fuzz (release)        | `go test -fuzz=Fuzz... -fuzztime=60s ./...`                |
| Lint                  | `golangci-lint run ./...`                                  |
| Vulnerability         | `govulncheck ./...`                                        |
| CodeQL                | (GitHub-side, security-extended + security-and-quality)    |
| Trivy filesystem      | (GitHub-side, daily + per-PR)                              |

CI runs all of these. If anything fails, fix the underlying issue rather
than disabling the check.

## Schema changes

The output schema (`schemas/output-v1.json`) is part of the public contract.
Adding optional, non-required fields is non-breaking and stays in `v1`.
Removing, renaming, or changing the type/required-ness of an existing field
requires:

1. A new `schemas/output-vN.json` document.
2. A bump of `audit.SchemaVersion`.
3. A major-version release.
4. Migration notes in `CHANGELOG.md` and `docs/SCHEMA.md`.

## Charset registry changes

`internal/charset/registry.go` IDs are versioned (`alphanum-v1`, etc.).
Adding new charsets is non-breaking. Modifying the runes behind an existing
ID is **breaking**: bump the suffix to `-v2` and keep the old entry until
the next major.

The registry stability test (`internal/charset/charset_test.go`) hashes
each charset's runes; any modification fails the test until the ID changes.

## Commit style

Commits and squash-merge titles follow Conventional Commits. release-please
reads the subject on `main` to open the next release:

- `feat:` opens a minor release
- `fix:` and `perf:` open a patch release
- `docs:`, `refactor:`, `test:`, `build:`, `ci:`, and `chore:` do not bump the version

Write the subject in imperative English: `fix: count entropy in runes`.
A scope is optional: `fix(mcp): override @hono/node-server`. Pull request
titles are checked by `.github/workflows/pr-title.yml` because squash merge
keeps the title as the commit subject.

Do not add assistant signatures (`Co-Authored-By` and similar).

## Pull request workflow

1. Fork and branch from `main`.
2. Make focused, atomic commits.
3. `go test ./... && golangci-lint run` locally.
4. Open a PR with a description focused on _why_, not _what_ (the diff
   shows what).
5. Reference any related issues.
6. Wait for CI green and a review.

## CodeQL alerts

The CodeQL `go/weak-cryptographic-algorithm` rule fires on
`internal/audit/log.go:SHA256Hex` because the helper hashes a value
named "password". This is a documented false positive: the SHA-256 here
fingerprints credentials for audit-log correlation, **not** verifier-side
password storage (which would require a slow KDF like Argon2id).

The custom workflow `.github/workflows/codeql.yml` excludes the rule for
this file via `.github/codeql/codeql-config.yml` and runs cleanly. If
GitHub's "CodeQL analysis (Default Setup)" is also enabled on the repo,
it will not respect that config and will re-raise the alert.

To resolve:

- **Preferred**: disable Default Setup at
  Settings → Security → Code security and analysis → CodeQL analysis
  → switch from "Default" to "Advanced". Our workflow then becomes the
  single source of truth.
- **Alternative**: dismiss the alert via Security → Code scanning with
  reason "Won't fix" and the justification text in `internal/audit/log.go`.

## Releases

release-please opens a release pull request from Conventional Commits on
`main`. Merging that pull request creates the `vX.Y.Z` tag and the GitHub
Release. `.github/workflows/release.yml` then produces signed binaries,
SBOMs, container images, and SLSA L3 provenance.

The release-please workflow needs a `RELEASE_PLEASE_TOKEN` repository
secret: a fine-grained PAT or GitHub App token with Contents write that is
allowed to trigger workflows. A tag created with the default `GITHUB_TOKEN`
does not start `release.yml`. The manifest in
`.release-please-manifest.json` is `2.0.0`, so the next release is computed
from commits after that tag.

The hand-written `## [Unreleased]` section in `CHANGELOG.md` is not
regenerated from commits. Review the first release pull request and fold
that prose into the generated section before merging.

Pushing a tag by hand still runs `release.yml`. Prefer the release pull
request so the changelog and the tag stay in step.

Pre-release alpha tags (`v2.0.0-alpha.N`) are used to validate the supply
chain pipeline before any GA tag.

### Package registries

The release pipeline publishes to four registries on every tag. The
maintainer setup is one-time:

| Registry        | Mechanism                  | One-time setup                                                                                                                                                                                                                                           |
| --------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ghcr.io         | `GITHUB_TOKEN` (built-in)  | none                                                                                                                                                                                                                                                     |
| npm (cli + mcp) | `NPM_TOKEN` repo secret    | Generate at https://www.npmjs.com/settings/{user}/tokens (Granular, publish-only on the `@secretgenerator` scope)                                                                                                                                        |
| Homebrew tap    | `HOMEBREW_TAP_TOKEN` PAT   | Fine-grained PAT with `Contents: write` on `rafaelperoco/homebrew-tap`                                                                                                                                                                                   |
| PyPI            | OIDC trusted publishing    | Configure at https://pypi.org/manage/project/secretgenerator-py/settings/publishing/ with workflow=`release.yml`, environment=`pypi`. The first publish must be done manually with `python -m build && twine upload dist/*` to reserve the project name. |
| crates.io       | `CRATES_TOKEN` repo secret | Generate at https://crates.io/settings/tokens with publish-update scope. The first publish must be done manually with `cargo publish` to reserve the crate name.                                                                                         |

When a token expires or is rotated, update the corresponding repo
secret via `gh secret set <NAME> --repo rafaelperoco/secretgenerator`.

## Questions

Open a [Discussions thread](https://github.com/rafaelperoco/secretgenerator/discussions)
for design questions. Use [Issues](https://github.com/rafaelperoco/secretgenerator/issues)
for bugs and feature requests. Use [Security Advisories](https://github.com/rafaelperoco/secretgenerator/security/advisories/new)
for vulnerabilities (see `SECURITY.md`).

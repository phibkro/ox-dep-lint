# Changesets

Every pull request adds a file here that says how the change affects ox-dep-lint's version and what its users should know: run `bunx changeset` and pick `patch`, `minor` or `major` by [semantic versioning](https://semver.org), or `bunx changeset --empty` when nothing that ships changes (CI, docs, tests). CI fails a pull request without one, or with one that does not version cleanly (the `pull-request` check is required on main).

The release workflow (`.github/workflows/release.yml`) turns the changesets on `main` into a release pull request with the version bump and the `CHANGELOG.md` entry; merging it publishes to npm, tags `vX.Y.Z` and makes a GitHub release.

Before 1.0, a breaking change to the configuration or to what the rules report is a `minor` bump; afterwards it is `major`.

# Version support (informal commitment)

Following [`SECURITY.md`](../SECURITY.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md):

- **`4.x` (semver major 4)** is the actively maintained line. semver-minor bumps add features; patch bumps ship fixes compatible with semver rules in [`CHANGELOG.md`](../CHANGELOG.md).
- Older majors (**`3.x` and below**) are **best-effort**—upgrade using migration notes embedded in changelog sections.
- **Node**: follow [`engines`](../package.json) (**Node ≥ 20.19** currently). Updating the minimum Node is semver-minor unless forced by CVE / ecosystem breakage (`CHANGELOG` explains).
- Breaking API changes bump **semver major**. Deprecations SHOULD carry one minor’s warning (`@deprecated` JSDoc).

This is guidance, not a paid SLA—the maintainers prioritize current consumers on the newest minor.

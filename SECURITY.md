# Security policy

## Supported versions

We issue fixes for **the latest semver minor within the actively published major** (`4.x` at time of writing). Older majors are best-effort; upgrade using [CHANGELOG.md](CHANGELOG.md) migration notes.

## Reporting a vulnerability

Use **[GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** for this repository when available, or open a **`[SECURITY]`** issue only if coordinated disclosure channels are unreachable.

Include reproduction steps **without exposing production secrets** and propose an embargo window (90 days suggested) before public disclosure unless the vulnerability is already public.

Because **library consumers** mount sensitive routes (`createAdminRouter`, Fastify plugin, etc.), document **least privilege**, **authentication**, **network segmentation**, and **`KeyManager`** sync semantics in deployment reviews—not only upstream dependency patching.

## Supply chain signals

Official npm publishes run through GitHub Actions ([.github/workflows/publish.yml](.github/workflows/publish.yml)) using **`npm publish --access public`**.

After you configure npm **trusted publishing**/**OIDC** for this repo, add **`--provenance`** to the publish command and grant GitHub **`id-token: write`** per npm docs. Classic **`NPM_TOKEN`** flows often cannot attach provenance without that linkage, so flipping the flag early can fail releases.

You can sanity-check broader repository security hygiene with the **[OpenSSF Scorecard viewer](https://scorecard.dev/viewer/?repo=github.com/ashwinpaulallen/ratelimit-flex)** (`github.com/ashwinpaulallen/ratelimit-flex`). Automated scores are heuristic—treat them as one signal among many during release review.

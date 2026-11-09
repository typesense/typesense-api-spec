# Typesense API Specs

This repository contains the API specs for the Typesense HTTP API.

Some of the client libraries use the specs from this repo to generate types.

## Usage

You can use Swagger Editor to view/edit the API spec files.

Clone this repo, and then from the root of this repo, run:

```bash
docker run -p 8080:8080 -v $(pwd):/tmp -e SWAGGER_FILE=/tmp/openapi.yml swaggerapi/swagger-editor
```

Now visit [http://localhost:8080](http://localhost:8080) in your browser to view the spec file in your browser.

Once you've made edits, click on File -> Save as YAML. Then copy that file into this repo and rename the file to use a `.yml` extension.

## API extractor

`src/` extracts routes and their path, query and body parameters from the Typesense C++ source on GitHub (see `config.json`) and writes them to `output/`. The `Extract Typesense API` workflow runs this nightly. When the API shape changes, it opens a pull request with the new output and a report linking each change to the Typesense source, so `openapi.yml` can be updated on the same branch. Changes that only move source lines don't open a pull request. `output/` holds the reviewed API shape, so merge the pull request even when `openapi.yml` needs no change; closing it only hides the changes until the next run opens a new one. Only runs on the default branch touch the pull request; a manual run on another branch writes the report to the run summary. A path in the config's `blacklist.paths` also covers its subpaths.

The project uses [Bun](https://bun.sh):

```bash
bun install --frozen-lockfile
bun test
bun run check
bun run lint

# Extract. A token is optional, but avoids the anonymous GitHub API rate limit.
GITHUB_TOKEN=$(gh auth token) bun src/cli.ts extract --config ./config.json

# Compare two extracted specs.
bun src/cli.ts semantic-diff --previous old.json --next new.json --markdown-output diff.md
```

To also run the integration tests, which extract from real source without using the network, clone Typesense into the gitignored `tmp/` folder. They skip when the clones are absent.

```bash
git clone https://github.com/typesense/typesense tmp/typesense
git clone -b v30 https://github.com/typesense/typesense tmp/typesense-v30
```

A path segment of `*` in the output means any key of a JSON object, as in `joins.*.allowed_fields`.

The extractor reads what the server's code reads, so `openapi.yml` remains the source of truth for fields it cannot see, such as the search parameters inside an opaque preset `value`.

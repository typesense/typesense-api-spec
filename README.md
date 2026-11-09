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

`src/` extracts the API's routes and parameters from the Typesense source into `output/`. A nightly workflow opens a pull request when they change, with a report linking each change to its source. Update `openapi.yml` on that branch, then merge it, even if nothing needed updating: closing it only defers the report to the next run.

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

To also run the integration tests, which extract from real source without using the network, clone Typesense into the gitignored `tmp/` folder. They skip without it.

```bash
git clone https://github.com/typesense/typesense tmp/typesense
```

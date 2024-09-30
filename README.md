# Typesense API Specs

This repository contains the API specs for the Typesense HTTP API.

Some of the client libraries use the specs from this repo to generate types.

## Usage

You can use Swagger Editor to view/edit the API spec files:

```bash
docker run -p 8080:8080 -v $(pwd):/tmp -e SWAGGER_FILE=/tmp/openapi.yml  swaggerapi/swagger-editor
```

Now visit localhost:8080 in your browser to view the spec file in your browser.

Once you've made edits, click on File -> Save as YAML. Then copy that file into this repo and rename the file to use a `.yml` extension.


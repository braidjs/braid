# Upstream A2UI files

Copied unmodified from [a2ui-project/a2ui](https://github.com/a2ui-project/a2ui) at commit
`496df0e76e2ad9aba4cc2a12abe066f43d4f171d`, under the Apache License 2.0 (`LICENSE` here).

- `json/` — `specification/v1_0/json/`: the v1.0 message, capability and catalog schemas.
- `catalogs/basic/catalog.json` — `catalogs/basic/v1/catalog.json`: the basic catalog.
- `examples/` — `catalogs/basic/v1/examples/`: the basic catalog's gallery.

They are test data. `@braidlabs/sdui` is checked against them: every example must round-trip (components nothing references are reported, not kept) through
the SDUI model, and everything this package emits must validate against these schemas. To update,
replace the files from a newer commit and change the commit above.

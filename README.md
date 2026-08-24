# YgoMaster Modding Tool

Modding Tool for [YgoMaster](https://github.com/pixeltris/YgoMaster) and its [LE mod](https://github.com/pixeltris/YgoMaster/issues/1).

## Features

- Manage intermediate files for gates and duels.
- Transform intermediate files into actual game data and vice versa.

## Card catalog

The catalog is display/search data only. YgoMaster's `CardList.json` and
`YdkIds.txt` remain the runtime ID authority. A refresh joins that runtime
intersection with injected Korean/English `cards.cdb` (or JSON fixture)
sources, stores the result in the persistent workspace database, and keeps the
previous catalog when a download fails. The persistent workspace data lives in
`.db/`: `catalog.json`, `metadata.json`, and the raw sources under
`.db/sources/{korean,english}/cards.cdb`.

Library/fixture callers may inject the card-source `transport` and runtime
release `runtimeTransport` independently, or provide `ygoMaster` input directly.

The approved Korean and English source URLs are built in. Set
`YGOMASTER_CATALOG_KOREAN_URL` and/or `YGOMASTER_CATALOG_ENGLISH_URL` only to
override them (and optional `*_REVISION` values), then use:

```text
node cli/index.js catalog status
node cli/index.js catalog refresh
node cli/index.js catalog refresh --online
node cli/index.js catalog search "type:monster race:dragon"
```

Tags generated from the source record are stored in `autoTags`; original
language records are retained separately. Korean names are preferred and
English names are used when Korean is unavailable. A normal refresh parses
valid local CDB files without downloading; `--online` explicitly updates both
approved sources after successful parsing. Source CDB files are never bundled
in a release.

## Layered campaign CLI

`campaign/content` is the only executable authored source. The CLI resolves
English card names and symbolic references locally, then generates managed
`campaign/source` IR. Read-only operations never update content, IR, or the ID
registry:

```text
node cli/index.js content inspect
node cli/index.js content resolve
node cli/index.js content validate
node cli/index.js content compile --check
node cli/index.js content diff
```

Publishing is explicit and generation-guarded. Copy `contentGeneration` from
`content inspect`, review the semantic diff, then run:

```text
node cli/index.js content compile --apply --expected-generation <sha256>
```

Managed deploys require matching content, compiler, catalog, ID-registry, and
target-contract generations. `--allow-legacy-ir` exists only for an explicitly
reviewed pre-migration source and is never implied by content commands.

Existing active source is inventoried separately and is never auto-merged with
`source-legacy`. Preview is read-only. Apply accepts only a reviewed candidate
directory and both generations copied from that preview:

```text
node cli/index.js migration preview
node cli/index.js migration preview --candidate <reviewed-content-directory>
node cli/index.js migration apply --candidate <reviewed-content-directory> --accept --expected-source-generation <sha256> --expected-candidate-generation <sha256>
```

Apply atomically replaces the content directory and preserves the exact active
source under the generation-addressed `.migration-backups/` workspace folder.
An empty active skeleton is reported and blocked instead of being presented as
a successful content migration.

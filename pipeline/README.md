# LibBot corpus pipeline

Refreshes the RAG corpus end to end: scrape LibGuides → validate → embed
and build ChromaDB. See `PIPELINE_PLAN.md` (repo root) for the full data
contract these scripts satisfy. On top of that contract's 8 columns, the
pipeline adds a 9th — `authors`, the guide's sidebar librarian profiles
(see Notes).

## Run order

```bash
# 1. Scrape all guides in url_list.csv (~8 min, polite 0.3s delay)
pixi run python pipeline/scrape_guides.py

# 2. Validate the scrape (exits non-zero on schema violations)
pixi run python pipeline/validate_scrape.py

# 3. Build combined_text + Qwen embeddings + ChromaDB (~45-60 min on CPU)
pixi run python pipeline/build_chromadb.py
```

All scripts take `--help` for path overrides. Defaults read
`/dsl/libbot/data/url_list.csv` and write `*_new` files alongside the
production data, which is never touched:

| Output | Path |
|--------|------|
| Scraped corpus | `/dsl/libbot/data/text_full_libguide_new.csv` |
| Corpus + combined_text | `/dsl/libbot/data/combined_text_full_libguide_new.{csv,parquet}` |
| Embeddings | `/dsl/libbot/data/embeddings_qwen_new.npy` |
| ChromaDB | `/dsl/libbot/data/chroma_db_new/` |

## Deploying a new corpus

Either point `CHROMA_DB_PATH` in `.env` at the new directory, or swap
directories and restart the API:

```bash
mv /dsl/libbot/data/chroma_db /dsl/libbot/data/chroma_db_old
mv /dsl/libbot/data/chroma_db_new /dsl/libbot/data/chroma_db
```

Smoke-test retrieval before deploying:

```bash
CHROMA_DB_PATH=/dsl/libbot/data/chroma_db_new pixi run python test_retriever.py
```

## Notes

- Row granularity matches the Feb 2025 corpus: one row per resource link
  (`chunk_title` = resource name, `text` = its description). Box prose with
  no link is also captured, as rows with empty `external_url` (the original
  R scrape dropped these).
- The `authors` column is a JSON array per guide (repeated on each row) of
  the librarian profiles in the guide's sidebar box ("Research Support" or
  similar): `[{"name", "profile_url", "email"}, ...]`. The page only embeds
  an email in a `<ucdlib-author-profile>` component; name and profile URL
  are resolved via the library directory API
  (`https://library.ucdavis.edu/wp-json/ucdlib-directory/person/<email>`),
  cached per email. The field is stored in ChromaDB metadata as a string,
  but is not yet exposed in API responses — that would require extending
  `Source` in `libbot_pkg/models.py` and the retriever.
- Guides that 404 or redirect off `guides.library.ucdavis.edu` are skipped
  and listed at the end of the scrape log.
- `validate_scrape.py` compares against the previous corpus
  (`text_full_libguide.csv`) and warns about guides that lost >50% of their
  rows — worth a manual look before building the DB. It also validates
  `authors`: every value must parse as a JSON list with name/profile_url/
  email keys, and it fails outright if fewer than 50% of guides have at
  least one author (a sign extraction broke). Guides legitimately without
  a sidebar profile are listed as a warning (~10% as of June 2026).

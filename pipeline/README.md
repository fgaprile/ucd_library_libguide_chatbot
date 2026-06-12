# LibBot Corpus Pipeline

This directory contains the scripts used to refresh the LibBot RAG corpus end to end: scraping the UC Davis LibGuides, validating the scraped data, and building the embeddings and ChromaDB collection that the retriever runs on.

> [!NOTE]
> For the corpus swap procedure and server operation, see the [Maintenance Guide](https://github.com/datalab-dev/ucd_library_libguide_chatbot/blob/main/docs/maintenance.md). The full data contract these scripts satisfy is described in `PIPELINE_PLAN.md` (repo root), and the design rationale is covered in the [Methodology Notes](https://github.com/datalab-dev/ucd_library_libguide_chatbot/blob/main/docs/methodology.md).

<br>

---

## Run Order

```bash
# 1. Scrape all guides in url_list.csv (~10 min, polite 0.3s request delay)
pixi run python pipeline/scrape_guides.py

# 2. Validate the scrape (exits non-zero on contract violations)
pixi run python pipeline/validate_scrape.py

# 3. Build combined_text + Qwen embeddings + ChromaDB (~45–60 min on CPU)
pixi run python pipeline/build_chromadb.py
```

All scripts take `--help` for path overrides. Defaults read `/dsl/libbot/data/url_list.csv` and write `*_new` files alongside the production data, which is **never touched**:

| Output | Path |
|--------|------|
| Scraped corpus | `/dsl/libbot/data/text_full_libguide_new.csv` |
| Corpus + combined_text | `/dsl/libbot/data/combined_text_full_libguide_new.{csv,parquet}` |
| Embeddings | `/dsl/libbot/data/embeddings_qwen_new.npy` |
| ChromaDB | `/dsl/libbot/data/chroma_db_new/` |

> [!NOTE]
> Deploying a freshly built corpus is a directory swap — see [Refreshing the Corpus](https://github.com/datalab-dev/ucd_library_libguide_chatbot/blob/main/docs/maintenance.md#refreshing-the-corpus) in the Maintenance Guide. Smoke-test retrieval against the new database before swapping:
> ```bash
> CHROMA_DB_PATH=/dsl/libbot/data/chroma_db_new pixi run python test_retriever.py "your query here"
> ```

<br>

---

## Data Notes

- **Row granularity** matches the original February 2025 corpus: one row per resource link, with `chunk_title` = resource name and `text` = its description. Box-level prose with no link is also captured, as rows with an empty `external_url` (the original R scrape dropped these).
- **The `authors` column** is a JSON array per guide (repeated on each of its rows) of the librarian profiles in the guide's sidebar box ("Research Support" or similar): `[{"name", "profile_url", "email"}, ...]`. The page only embeds an email in a `<ucdlib-author-profile>` component; name and profile URL are resolved through the library directory API the component itself calls (`https://library.ucdavis.edu/wp-json/ucdlib-directory/person/<email>`), cached per email. The field is stored in ChromaDB metadata and surfaced as a byline in the frontend's sources list.
- **Guides that 404 or redirect off `guides.library.ucdavis.edu`** are skipped and listed at the end of the scrape log.
- **`validate_scrape.py`** compares against the previous corpus (`text_full_libguide.csv`) and warns about guides that lost >50% of their rows — worth a manual look before building the DB. It also validates `authors`: every value must parse as a JSON list with name/profile_url/email keys, and it fails outright if fewer than 50% of guides have at least one author (a sign extraction broke). Guides legitimately without a sidebar profile are listed as a warning (~10% as of June 2026).

# Maintenance Guide

This guide covers everything needed to configure, run, and verify the LibBot server.
It is intended for maintainers with access to the UC Davis DataLab datasci server.

<br>

> [!NOTE]
> ### LLM Evaluated
> Information regarding the LLMs used in the document synthesis portion of the RAG system can be found in the [Ollama notes](https://github.com/datalab-dev/ucd_library_libguide_chatbot/blob/main/docs/ollama.md) doc.


---

## Prerequisites

Before starting LibBot, make sure the following are in place:

1. You are connected to the **UC Davis Library Staff VPN**
2. Have SSH access to the datasci server
3. Have the pixi environment installed — if not, run `pixi install` from the project root

<br>

---

## Configuration

All settings are defined in `config.py` and can be overridden via `.env`. The following variables are available and alterable:

| Setting | Default | Description |
|---|---|---|
| `CHROMA_DB_PATH` | `/path/to/chroma_db` | Path to ChromaDB on disk |
| `COLLECTION_NAME` | `your_collection` | ChromaDB collection name |
| `MODEL_NAME` | `Qwen/Qwen3-Embedding-0.6B` | Sentence embedding model |
| `TORCH_NUM_THREADS` | `16` | CPU threads for embedding inference |
| `TOP_K` | `3` | Number of results to retrieve |
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama API endpoint |
| `OLLAMA_MODEL` | `llama3:8b` | Ollama model to use |
| `HOST` | `0.0.0.0` | Server host |
| `PORT` | `8075` | Server port |

<br>

---

## Refreshing the Corpus

The LibGuides corpus can be re-scraped and rebuilt at any time using the scripts in `pipeline/`. The full process takes roughly an hour, most of it embedding generation on CPU. Run the three steps in order from the project root:

**Step 1 — scrape the current LibGuides (~10 min):**
```bash
pixi run python pipeline/scrape_guides.py
```

**Step 2 — validate the scrape:**
```bash
pixi run python pipeline/validate_scrape.py
```

**Step 3 — build embeddings and the new ChromaDB (~45–60 min):**
```bash
pixi run python pipeline/build_chromadb.py
```

All outputs are written to `*_new` paths next to the production data, so the live database is never touched while the server runs. Once the build completes, swap the new database in, keeping the old one as a rollback:

```bash
mv /dsl/libbot/data/chroma_db /dsl/libbot/data/chroma_db_old
mv /dsl/libbot/data/chroma_db_new /dsl/libbot/data/chroma_db
```

Then verify retrieval (see [Verifying Functionality](#verifying-functionality)) and restart the server.

> [!NOTE]
> Step 2 exits non-zero if the scrape violates the data contract — do not proceed to Step 3 if validation fails. For per-script options, output schemas, and data notes, see the [Pipeline README](https://github.com/datalab-dev/ucd_library_libguide_chatbot/tree/main/pipeline).

<br>

---

## Running the Server

LibBot requires two processes running simultaneously — Ollama and the LibBot package itself.
Open two terminals on the datasci server and run one in each:

**Terminal 1 — start Ollama:**
```bash
pixi run ollama-serve
```

**Terminal 2 — start LibBot:**
```bash
pixi run python -m libbot_pkg
```

A successful startup looks like:
```
Connecting to ChromaDB at: /dsl/libbot/data/chroma_db
Loading embedding model: Qwen/Qwen3-Embedding-0.6B
Retriever ready.
INFO:     Uvicorn running on http://0.0.0.0:8075
```

Once running, LibBot is accessible to anyone on the UC Davis Library VPN at:
```
http://datasci.library.ucdavis.edu:8075
```

> [!NOTE]
> Both processes must stay running for LibBot to work. If either terminal is closed
> or the session drops, the server will go down. At the moment, to ensure this `tmux`
> is being used to keep sessions alive across SSH disconnections.

<br>

---

## API Reference

All endpoints are available at `http://datasci.library.ucdavis.edu:8075`.
The full interactive API reference is available at `/docs` when the server is running.

### `POST /chat`
Full pipeline — retrieves documents, builds a context-aware prompt, and streams the LLM response token by token.

**Request:**
```json
{ "message": "how do I find peer reviewed articles?", "top_k": 3 }
```

**Response:** a plain text stream. The first line is a `SOURCES:` JSON payload containing
the retrieved documents. All following content is the LLM response streamed token by token:
```
SOURCES:[{"score": 0.91, "text": "...", "sources": [{...}]}]
This is a topic that...
```

---

### `POST /search`
Raw retrieval only — no LLM involved. Useful for testing or building alternative frontends.

**Request:**
```json
{ "query": "how do I find peer reviewed articles?", "top_k": 3 }
```

**Response:**
```json
{
  "query": "how do I find peer reviewed articles?",
  "top_k": 3,
  "results": [
    {
      "score": 0.91,
      "text": "...",
      "sources": [
        {
          "libguide_title": "Citation Guide",
          "section_title": "APA Format",
          "url": "https://..."
        }
      ]
    }
  ]
}
```

---

### `GET /health`
Liveness check — confirms the server is running.
```json
{ "status": "ok" }
```

<br>

---

## Verifying Functionality

As shown in the main project README, to verify the retrieval pipeline works independently of the web server, go to the project root and run the test script with a query, as follows:
```bash
pixi run python test_retriever.py "your query here"
```

> This checks the config, loads the retriever, runs a real query against ChromaDB, and prints the full structured response. Run this after any changes to `retriever.py`, `config.py`,
or the ChromaDB data to confirm everything is working before restarting the server.

Search long-term memory for relevant information. Returns raw matching entries ranked by relevance.

Use proactively — before answering questions about past conversations, user preferences, project decisions, or any topic where prior context would help accuracy. When in doubt, recall first.


The query supports two forms:
- a natural-language phrase for BM25 + vector search
- `id:<memory-id>` (or a `[id: …]` token copied from prior recall output) to look up one specific stored memory by id without re-searching

Prefer `recall` when you need specific facts or entries. Use `reflect` instead when you need a synthesised answer across many memories.

// FR-3: native Neo4j vector index on Clause.embedding_ref, cosine
// similarity, dimension 1536 (spec §13 open question #3 — recommended
// default until an embedding model is formally chosen; see the
// serialize/deserialize boundary comment in
// src/repositories/clause.repository.ts for the string<->LIST<FLOAT>
// typing tension this resolves per spec §13 open question #2).
CREATE VECTOR INDEX clause_embedding_index IF NOT EXISTS
FOR (c:Clause) ON (c.embedding_ref)
OPTIONS {
  indexConfig: {
    `vector.dimensions`: 1536,
    `vector.similarity_function`: 'cosine'
  }
};

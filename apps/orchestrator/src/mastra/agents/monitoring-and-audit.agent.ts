// Monitoring and Audit Agent — deterministic.
// Tracks fulfilment against each ProcessTask, ingests EvidenceArtifact
// records, flags gaps before deadlines, and logs every human reviewer
// decision. The only agent that writes to the Hash-chained Audit Ledger,
// and the agent that actually writes the HumanReview node once a
// reviewer decides (see architecture walkthrough §3).
export const monitoringAndAuditAgent = {
  name: "monitoring-and-audit",
  description: "Tracks ProcessTask fulfilment and evidence, logs HumanReview decisions to the hash-chained Audit Ledger."
};

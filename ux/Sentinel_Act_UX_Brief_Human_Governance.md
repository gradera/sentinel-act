# Sentinel Act: UX Brief for Human Governance

## 1. What this system does, in one paragraph

Sentinel Act reads SEBI circulars and turns them into structured, machine-actionable compliance Obligations and operational tasks, automatically. Nothing it produces goes live on its own. Every proposed change is risk-scored and routed to a human reviewer under a tiered policy before it becomes an operational instruction a real compliance team acts on. The screens in this brief are where that human review actually happens.

## 2. Who uses this

**Compliance Officer (primary persona, Tier B reviewer).** Reviews medium-risk or first-seen-type changes alone. Works under an SLA clock. Needs to trust the system's extraction before approving, not just click through it. Time-pressured, handles a queue alongside other duties, not a full-time reviewer role.

**Senior Compliance Officer / second approver (Tier C reviewer).** Only sees the highest-risk changes: penalty-bearing, deadline-bound, or anything overwriting a currently live obligation. Reviews independently of the first reviewer, cannot see or be influenced by the first reviewer's decision until their own is submitted (this is a hard design constraint, not a nice-to-have, it is what makes maker-checker real rather than theatrical). Needs the fullest context of anyone in this system.

**Backup reviewer.** Only appears when an SLA is missed. Needs to get full context fast, with zero ramp-up time, since they are picking up someone else's queue mid-flight.

**Compliance Head / auditor (secondary persona, read-only).** Doesn't approve anything. Wants to query "who approved what, and why" after the fact, and to see the audit trail as a queryable record, not a document they have to go dig for.

Everyone above is a professional under regulatory obligation themselves. Design for competence and speed, not for hand-holding. The tone is closer to a trading terminal or an underwriting queue than a consumer app.

## 3. The policy these screens have to make legible

| Tier | When it applies | What the human does |
|---|---|---|
| A, auto-commit | High confidence, high grounding, low risk, no contradiction | Nothing, in real time. Sampled for periodic spot checks. |
| B, single reviewer | Medium confidence or risk, or a first-seen obligation type | One Compliance Officer approves or rejects, inside an SLA window |
| C, maker-checker | High risk: penalty-bearing, deadline-bound, or supersedes a live obligation | Two independent reviewers must both approve before it goes live |
| Always-escalate | Any contradiction or grounding failure flagged by the system | Cannot be auto-committed or single-approved, full stop, regardless of confidence score |

A reviewer should always be able to tell, at a glance, which tier they're looking at and why the system put it there. That "why" (the risk score's actual inputs: penalty severity, deadline proximity, whether it changes something currently live) is not optional trivia, it's the thing that lets a reviewer trust a routing decision instead of second-guessing it.

## 4. What's on screen: the underlying data

Every screen in this system is a view over the Regulatory Knowledge Graph. The fields below are real fields from the schema, not placeholders:

**The source, always visible:** `Circular.title`, `Clause.para_ref`, `Clause.text` (the literal clause wording).

**The proposed change, side by side with the source:** `Obligation.requirement_text`, `trigger_event`, `deadline_rule`, `responsible_role`, `penalty_ref`, `confidence_score`, `grounding_score`, `status`.

**The operational consequence:** `ProcessTask.task_name`, `owner_role`, `sla_hours`, `system_touchpoint`, `risk_score`, shown as a redline diff against whatever ProcessTask it's replacing, if any.

**The lineage:** the full chain, Circular to Clause to Obligation to ProcessTask to EvidenceArtifact, so a reviewer can trace any claim back to its literal source in one click, not a search.

**The decision, once made:** `HumanReview.reviewer_id`, `tier`, `decision`, `rationale`, `decided_at`. Rationale is a required field for Tier C, not optional, design the form so skipping it is not a smooth path.

## 5. User journeys

Use these as the basis for the Figma flows. Each one names the trigger, the screens it touches, and the moment that actually matters, the point where a wrong design decision would either slow a reviewer down or let them approve something they didn't really evaluate.

### Journey A: Tier B single sign-off

- **Trigger:** an Obligation lands in the reviewer's queue with an SLA due-by timestamp attached.
- **Entry point:** queue view, sorted by risk score and time-to-SLA, not by arrival order. A reviewer's first question is always "what's about to breach," design the sort for that.
- **Step 1, queue:** reviewer sees item, obligation category, one-line summary, confidence and grounding scores, SLA countdown. Enough to triage without opening it.
- **Step 2, detail view:** source clause and extracted Obligation side by side. Redlined ProcessTask diff below it. Full lineage breadcrumb. This is the screen that has to earn trust, the source text must be undeniably the literal clause, not a paraphrase, and it must be impossible to miss that it's the literal source.
- **Step 3, decision:** approve or reject, with an optional rationale field (required only at Tier C, but always available at Tier B, since good reviewers will want to leave one anyway).
- **Step 4, confirmation:** decision is written back as a HumanReview fact. Queue updates. SLA clock for this item stops.
- **Moment that matters:** step 2. If the redline diff or the source-to-obligation comparison is hard to parse, reviewers will start rubber-stamping to clear the queue, which defeats the entire point of the tier.

### Journey B: Tier C maker-checker dual sign-off

- **Trigger:** a high-risk Obligation (penalty-bearing, deadline-bound, or overwriting a live obligation) is routed to two reviewers.
- **Reviewer 1 (maker):** same detail view as Journey A, but the screen must clearly state "this requires a second, independent approval" and must not show whether a second reviewer has been assigned yet or what they might think. Rationale is required, not optional, before the approve button is enabled.
- **Reviewer 2 (checker):** sees the same source-to-obligation-to-task view, entirely independently. Design constraint: reviewer 2 must not see reviewer 1's decision or rationale before submitting their own. Only after both are in does the system reveal both to each other. This is the hardest UX constraint in this brief and the most important one, if reviewer 2 can see reviewer 1 went first, the second signature stops being independent.
- **Resolution:** once both approve, the change commits and both HumanReview facts are linked to the same Obligation. If they disagree, the change is blocked and escalates, design an explicit disagreement state, don't let it silently stall.
- **Moment that matters:** the independence constraint above. Get this wrong and the whole maker-checker story becomes cosmetic.

### Journey C: SLA breach and escalation (Signals)

- **Trigger:** a queued item's SLA due-by timestamp is approaching or has passed.
- **Step 1:** as the deadline nears, a reminder surfaces to the assigned reviewer (in-app and via the Signals channel, which in the current build is a Slack message, design the in-app equivalent of that same nudge).
- **Step 2, if missed:** the item auto-escalates to a backup reviewer. The backup reviewer's queue view must show this item flagged as escalated, with a visible reason ("SLA missed, reassigned from X"), not just appear silently in their list.
- **Step 3:** backup reviewer opens the same detail view as Journey A, but needs a compressed "catch up fast" version, maybe a summary strip at the top: what it is, why it's high priority, how long it's been waiting.
- **Moment that matters:** step 2. A backlog that silently stalls is exactly the failure mode this whole system exists to prevent, the escalation has to be loud, not a queue re-sort nobody notices.

### Journey D: always-escalate on contradiction

- **Trigger:** the Grounding and Verification agent flags a contradiction between a new Obligation and an existing live one, or a grounding failure (the extraction doesn't actually match the source text).
- **Design requirement:** this state must look visually distinct from a normal Tier B or C item, it cannot be auto-committed or single-approved under any circumstance, and the UI should make that structurally true, not just state it in a warning banner. Consider disabling the single-approve action entirely on this item type rather than relying on the reviewer to notice a label.
- **Step 1:** reviewer sees the specific contradiction, ideally the two conflicting Obligations shown side by side with the divergent field highlighted, not a generic "conflict detected" message.
- **Step 2:** reviewer resolves by escalating to Tier C review or rejecting the proposed change outright.
- **Moment that matters:** step 1's specificity. A vague contradiction warning trains reviewers to dismiss it; a precise one (this obligation says 5 days, the live one says 3) is what actually gets acted on.

### Journey E: Slack quick-approve path

- **Trigger:** same Tier B/C routing as Journeys A and B, but the reviewer chooses the fast path instead of opening the console.
- **Flow:** an interactive card in Slack shows a condensed version, obligation summary, risk tier, approve/decline buttons. This is intentionally lighter than the console, for reviewers who don't need the full lineage view for a given item.
- **Design requirement:** the Slack card and the console detail view must show the same underlying decision consistently, whichever path a reviewer uses, the resulting HumanReview fact looks identical to an auditor later. The designer's job here is mostly the card content hierarchy (what's essential enough to fit in a Slack card without losing the reviewer's ability to make an informed call), not the interaction itself.
- **Constraint:** Tier C's second signature can happen via Slack too, but the independence rule from Journey B still applies, the card must not reveal the first reviewer's decision.

### Journey F: audit lookup (Compliance Head / auditor)

- **Trigger:** someone asks "who approved this obligation, and why," after the fact, days or months later.
- **Flow:** a read-only view, searchable by Obligation, Circular, or reviewer, surfaces the full HumanReview trail: who, what tier, what decision, what rationale, when. This is a query interface, not a document, treat it like a filterable log/table, not a static report.
- **Adjacent surface:** the optional Conversational Assistant lets this persona ask the same question in plain English ("what did we approve for stockbrokers last month") and get an answer with citations back to the graph. It's read-only and cannot be used to approve or reject anything, make that boundary visually obvious wherever the assistant appears (a different visual treatment from the console, so nobody mistakes a chat answer for a governance action).

## 6. Screen inventory (what to actually design)

1. Reviewer queue (Tier B and Tier C combined, filterable), sorted by risk and SLA proximity
2. Item detail view: source clause, extracted Obligation, redlined ProcessTask diff, lineage breadcrumb
3. Sign-off panel: approve/decline, rationale field (required at Tier C), tier-specific messaging
4. Tier C "awaiting second reviewer" state (maker's view after submitting)
5. Tier C independent second-review view (checker's view, no visibility into maker's decision)
6. Post-decision reveal (both signatures shown together, once both exist)
7. Contradiction/escalation state (visually distinct, restricted actions)
8. SLA breach and reassignment notice (backup reviewer's entry point)
9. Slack card (condensed approve/decline)
10. Audit/history lookup (searchable HumanReview log)
11. Conversational Assistant panel (chat, clearly marked read-only)

## 7. Human-centric design principles for this brief

- **Provenance over polish.** Every claim on screen traces to a literal source. If a design choice makes that traceability less obvious to save space, don't make it.
- **Design for triage speed, not first-time delight.** These are repeat, professional users under time pressure. Optimize for the twentieth use, not the first.
- **Make the tier and the reason for the tier unmissable.** A reviewer who doesn't understand why something is Tier C will treat it like Tier B.
- **Independence is a layout constraint, not a policy note.** Anywhere Journey B applies, the design itself must prevent premature visibility, not just instruct reviewers not to look.
- **Escalation should look urgent, not administrative.** A missed SLA is a real risk-management failure; the UI shouldn't let it read like a routine status change.
- **Read-only surfaces should look read-only.** The Conversational Assistant and the audit log should be visually unmistakable from anything that can change the graph.

## 8. Explicitly out of scope for this brief

- Tier A auto-commit needs no UI, it's logged, not reviewed, in real time.
- No end-investor or public-facing screens, every persona above is an internal compliance professional.
- No design work on the Regulatory Watch, Extraction, Verification, or Change-and-Delta agents, those are backend, not human-facing.
- No visual design system decisions yet (colors, type), this brief is journeys and screen content, not brand.

## 9. Open questions for the designer to raise with the team

- How much of the redline diff should be inline (side-by-side) versus a toggled view, given how dense ProcessTask fields can get?
- Should the queue support bulk action for Tier A spot-checks, or is that a different, lower-priority surface?
- What's the minimum viable mobile experience, if any, for a reviewer who needs to approve from a phone during an SLA-critical window?

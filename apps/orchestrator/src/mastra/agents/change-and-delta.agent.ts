// Change and Delta Agent — the flagship differentiator.
// Triggered by the Watch agent on a new or amended circular. Computes a
// structural graph diff between the pre- and post-amendment snapshot
// (closes valid_to on superseded Obligations, opens new ones) and drafts
// the redlined ProcessTask update shown in the reviewer's detail view.
export const changeAndDeltaAgent = {
  name: "change-and-delta",
  description: "Computes a structural graph diff across a circular amendment and drafts the redlined ProcessTask update."
};

// The page and invitation describe the same outing-specific offers, not the
// participant's subsequently edited profile or the original solver's prose.
export function equipmentList(outing) {
  if (outing.kind === "connection_test") return [];
  return [
    "Bring warm layers and a dim red light.",
    ...outing.people
      .filter(
        (p) => !["declined", "expired", "withdrawn"].includes(p.response),
      )
      .filter((p) => p.preferences.equipment?.length)
      .map(
        (p) =>
          `${p.preferences.name}: ${p.preferences.equipment.join(", ")}${p.preferences.shareEquipment ? " · happy to share" : ""}.`,
      ),
  ];
}

import { describe, expect, it } from "vitest";
import { itemsWithPending, selectItems } from "@/lib/utils/select-items";

/**
 * These two build the map Base UI's `<Select.Value>` resolves the trigger's
 * label from. The bug they exist to stop is a visible one — a UUID shown to
 * the user where a group's name belongs — and it is invisible to type checking,
 * so the cases below are the ones where the map is at its thinnest: the list
 * hasn't loaded, the list is empty, the selected value isn't in it.
 */

type Group = { id: string; name: string };

const groups: Group[] = [
  { id: "952bbb4d-32bb-40b9-8b1a-000000000001", name: "Sundry Debtors" },
  { id: "952bbb4d-32bb-40b9-8b1a-000000000002", name: "Bank Accounts" },
];

const byIdAndName = (g: Group) => [g.id, g.name] as const;

describe("selectItems", () => {
  it("maps each row's value to its label", () => {
    expect(selectItems(groups, byIdAndName)).toEqual({
      "952bbb4d-32bb-40b9-8b1a-000000000001": "Sundry Debtors",
      "952bbb4d-32bb-40b9-8b1a-000000000002": "Bank Accounts",
    });
  });

  it("keeps the fixed entries a filter adds on top of the data", () => {
    const items = selectItems(groups, byIdAndName, { all: "All groups" });
    expect(items.all).toBe("All groups");
    expect(items["952bbb4d-32bb-40b9-8b1a-000000000001"]).toBe("Sundry Debtors");
  });

  it("still answers with the fixed entries while the list is loading", () => {
    // The filter opens on its sentinel, so this is the map the trigger reads
    // on first paint — "All groups", not the word "all".
    expect(selectItems(undefined, byIdAndName, { all: "All groups" })).toEqual({ all: "All groups" });
    expect(selectItems(null, byIdAndName, { all: "All groups" })).toEqual({ all: "All groups" });
  });

  it("returns an empty map for an empty list and no fixed entries", () => {
    expect(selectItems([], byIdAndName)).toEqual({});
  });

  it("lets a row override a fixed entry rather than silently dropping it", () => {
    // Nothing in the app does this today, but if a real row ever collides with
    // a sentinel the visible list wins — the map has to agree with the options
    // the user can actually pick.
    const items = selectItems([{ id: "all", name: "All Ledgers group" }], byIdAndName, { all: "All groups" });
    expect(items.all).toBe("All Ledgers group");
  });

  it("takes a label that is not the row's own name", () => {
    // The voucher filter's labels come from a config, not from the values.
    const items = selectItems(["sales", "receipt"] as const, (t) => [t, t === "sales" ? "Sale Bill" : "Money In"], {
      all: "All types",
    });
    expect(items).toEqual({ all: "All types", sales: "Sale Bill", receipt: "Money In" });
  });
});

describe("itemsWithPending", () => {
  const loaded = { all: "All groups", "952bbb4d-32bb-40b9-8b1a-000000000001": "Sundry Debtors" };

  it("points an unresolved value at the placeholder", () => {
    const items = itemsWithPending({ all: "All groups" }, "952bbb4d-32bb-40b9-8b1a-000000000001", "Select a group");
    expect(items["952bbb4d-32bb-40b9-8b1a-000000000001"]).toBe("Select a group");
  });

  it("leaves a value the list already covers alone", () => {
    expect(itemsWithPending(loaded, "952bbb4d-32bb-40b9-8b1a-000000000001", "Select a group")).toBe(loaded);
  });

  it("leaves the map untouched when nothing is selected", () => {
    expect(itemsWithPending(loaded, null, "Select a group")).toBe(loaded);
    expect(itemsWithPending(loaded, undefined, "Select a group")).toBe(loaded);
    expect(itemsWithPending(loaded, "", "Select a group")).toBe(loaded);
  });

  it("does not mistake an inherited property for a real entry", () => {
    // `"toString" in items` would be true for every map there is; a ledger
    // group can't be called that, but the check being wrong for the general
    // case is how it would quietly stop covering some other value later.
    const items = itemsWithPending({ all: "All groups" }, "toString", "Select a group");
    expect(items.toString).toBe("Select a group");
  });

  it("does not mutate the map it was given", () => {
    const original = { all: "All groups" };
    itemsWithPending(original, "unknown-id", "Select a group");
    expect(original).toEqual({ all: "All groups" });
  });
});

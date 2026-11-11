import { SPACE_FILTER_OPERATORS } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { operatorLabel } from "./filterLabels";

describe("filter labels", () => {
  it("names every operator the contract offers for every type", () => {
    for (const [type, operators] of Object.entries(SPACE_FILTER_OPERATORS)) {
      for (const operator of operators) {
        const label = operatorLabel(operator, type);
        expect(label, `${type}.${operator}`).not.toBe(operator);
        expect(label).toMatch(/\S/);
      }
    }
  });

  it("uses symbols for number comparisons", () => {
    expect(operatorLabel("greater_than_or_equal_to", "number")).toBe("≥");
    expect(operatorLabel("greater_than", "text")).toBe("Greater than");
  });
});

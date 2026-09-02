import test from "node:test";
import assert from "node:assert/strict";
import {
  chartBuckets,
  mapBudgetsToResources,
  parseCostQuery,
  parseMetrics,
  percentOf,
  severityForPercent,
  sortRows,
  toCsv,
} from "../js/core.js";

test("les seuils changent à 75 % et 95 %", () => {
  assert.equal(severityForPercent(74.99), "normal");
  assert.equal(severityForPercent(75), "warning");
  assert.equal(severityForPercent(94.99), "warning");
  assert.equal(severityForPercent(95), "danger");
  assert.equal(percentOf(75, 100), 75);
  assert.equal(percentOf(10, 0), null);
});

test("les lignes sont triées sans modifier la source", () => {
  const source = [{ cost: 9 }, { cost: 2 }, { cost: null }];
  assert.deepEqual(sortRows(source, "cost", "asc").map((item) => item.cost), [2, 9, null]);
  assert.deepEqual(source.map((item) => item.cost), [9, 2, null]);
});

test("la réponse Cost Management est indexée par ressource", () => {
  const result = parseCostQuery({
    properties: {
      columns: [{ name: "ResourceId" }, { name: "Cost" }, { name: "Currency" }],
      rows: [["/SUB/R1", 12.5, "EUR"], ["/sub/r1", 2.5, "EUR"], ["/sub/r2", 4, "USD"]],
    },
  });
  assert.deepEqual(result.get("/sub/r1"), { cost: 15, currency: "EUR" });
  assert.deepEqual(result.get("/sub/r2"), { cost: 4, currency: "USD" });
});

test("les budgets filtrés par ResourceId sont associés", () => {
  const result = mapBudgetsToResources({
    value: [{
      name: "ai-prod",
      properties: {
        amount: 100,
        currentSpend: { unit: "EUR" },
        filter: { dimensions: { name: "ResourceId", values: ["/sub/R1"] } },
      },
    }],
  });
  assert.deepEqual(result.get("/sub/r1"), { amount: 100, name: "ai-prod", currency: "EUR" });
});

test("les séries Azure Monitor sont regroupées par horodatage et modèle", () => {
  const points = parseMetrics({
    value: [{
      timeseries: [{
        metadatavalues: [{ name: { value: "ModelName" }, value: "gpt-5" }],
        data: [{ timeStamp: "2026-09-02T10:00:00Z", total: 120 }],
      }],
    }, {
      timeseries: [{
        metadatavalues: [{ name: { value: "ModelName" }, value: "gpt-5" }],
        data: [{ timeStamp: "2026-09-02T10:00:00Z", total: 30 }],
      }],
    }],
  });
  assert.deepEqual(points, [{ timestamp: "2026-09-02T10:00:00Z", model: "gpt-5", value: 150 }]);
  const buckets = chartBuckets(points, "day", new Date("2026-09-02T15:00:00+02:00"));
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.total, 0), 150);
});

test("l’export CSV protège les séparateurs et guillemets", () => {
  const csv = toCsv([{ projet: 'Projet; "A"', cout: 12.5 }]);
  assert.equal(csv, 'projet;cout\n"Projet; ""A""";12.5');
});

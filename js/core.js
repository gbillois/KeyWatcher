export const STORAGE_KEY = "keywatcher.config.v1";
export const SESSION_KEY = "keywatcher.azure.session.v1";

export function defaultConfig() {
  return {
    schemaVersion: 1,
    azure: {
      tenantId: "organizations",
      clientId: "",
      selectedSubscriptions: [],
    },
    projects: {},
  };
}

export function normalizeConfig(value) {
  const fallback = defaultConfig();
  if (!value || typeof value !== "object") return fallback;
  const azure = value.azure && typeof value.azure === "object" ? value.azure : {};
  const projects = value.projects && typeof value.projects === "object" ? value.projects : {};

  return {
    schemaVersion: 1,
    azure: {
      tenantId: cleanText(azure.tenantId) || fallback.azure.tenantId,
      clientId: cleanText(azure.clientId),
      selectedSubscriptions: Array.isArray(azure.selectedSubscriptions)
        ? azure.selectedSubscriptions.map(cleanText).filter(Boolean)
        : [],
    },
    projects: Object.fromEntries(
      Object.entries(projects)
        .filter(([key, project]) => key && project && typeof project === "object")
        .map(([key, project]) => [key.toLowerCase(), {
          name: cleanText(project.name).slice(0, 120),
          budget: positiveNumber(project.budget),
          currency: cleanText(project.currency).slice(0, 8) || "EUR",
        }]),
    ),
  };
}

export function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function severityForPercent(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return "normal";
  if (value >= 95) return "danger";
  if (value >= 75) return "warning";
  return "normal";
}

export function percentOf(cost, budget) {
  const safeCost = positiveNumber(cost);
  const safeBudget = positiveNumber(budget);
  if (!safeBudget) return null;
  return (safeCost / safeBudget) * 100;
}

export function sortRows(rows, field, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = a[field];
    const right = b[field];
    const leftMissing = left === null || left === undefined || left === "";
    const rightMissing = right === null || right === undefined || right === "";
    if (leftMissing && rightMissing) return 0;
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
    return String(left).localeCompare(String(right), "fr", { numeric: true, sensitivity: "base" }) * factor;
  });
}

export function parseCostQuery(payload) {
  const properties = payload?.properties || {};
  const columns = Array.isArray(properties.columns) ? properties.columns : [];
  const rows = Array.isArray(properties.rows) ? properties.rows : [];
  const names = columns.map((column) => String(column?.name || "").toLowerCase());
  const resourceIndex = findColumn(names, ["resourceid", "resourceidentifier"]);
  const costIndex = findColumn(names, ["cost", "pretaxcost", "costusd"]);
  const currencyIndex = findColumn(names, ["currency", "billingcurrency"]);
  const result = new Map();

  if (resourceIndex < 0 || costIndex < 0) return result;
  for (const row of rows) {
    const resourceId = cleanText(row?.[resourceIndex]).toLowerCase();
    if (!resourceId) continue;
    const current = result.get(resourceId) || { cost: 0, currency: "EUR" };
    current.cost += positiveNumber(row?.[costIndex]);
    current.currency = cleanText(row?.[currencyIndex]) || current.currency;
    result.set(resourceId, current);
  }
  return result;
}

function findColumn(names, candidates) {
  for (const candidate of candidates) {
    const exact = names.indexOf(candidate);
    if (exact >= 0) return exact;
  }
  return names.findIndex((name) => candidates.some((candidate) => name.includes(candidate)));
}

export function resourceIdsFromBudgetFilter(filter) {
  const ids = new Set();
  visitBudgetFilter(filter, ids);
  return ids;
}

function visitBudgetFilter(node, ids) {
  if (!node || typeof node !== "object") return;
  const dimension = node.dimensions;
  if (dimension && String(dimension.name || "").toLowerCase() === "resourceid") {
    for (const value of dimension.values || []) {
      const id = cleanText(value).toLowerCase();
      if (id) ids.add(id);
    }
  }
  for (const branchName of ["and", "or"]) {
    const branch = node[branchName];
    if (Array.isArray(branch)) branch.forEach((child) => visitBudgetFilter(child, ids));
    else if (branch) visitBudgetFilter(branch, ids);
  }
}

export function mapBudgetsToResources(payload) {
  const result = new Map();
  for (const budget of payload?.value || []) {
    const ids = resourceIdsFromBudgetFilter(budget?.properties?.filter);
    for (const id of ids) {
      const amount = positiveNumber(budget?.properties?.amount);
      if (!amount) continue;
      const previous = result.get(id);
      if (!previous || amount < previous.amount) {
        result.set(id, {
          amount,
          name: cleanText(budget?.name) || "Budget Azure",
          currency: cleanText(budget?.properties?.currentSpend?.unit) || "EUR",
        });
      }
    }
  }
  return result;
}

export function parseMetrics(payloads) {
  const points = new Map();
  for (const payload of Array.isArray(payloads) ? payloads : [payloads]) {
    for (const metric of payload?.value || []) {
      for (const series of metric?.timeseries || []) {
        const metadata = Object.fromEntries(
          (series.metadatavalues || []).map((item) => [
            String(item?.name?.value || item?.name?.localizedValue || "").toLowerCase(),
            cleanText(item?.value),
          ]),
        );
        const model = metadata.modelname || metadata.modeldeploymentname || "Modèle non identifié";
        for (const datum of series.data || []) {
          const timestamp = cleanText(datum.timeStamp || datum.timestamp);
          const value = positiveNumber(datum.total ?? datum.sum ?? datum.average);
          if (!timestamp || !value) continue;
          const key = `${timestamp}|${model}`;
          points.set(key, {
            timestamp,
            model,
            value: (points.get(key)?.value || 0) + value,
          });
        }
      }
    }
  }
  return [...points.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.model.localeCompare(b.model));
}

export function chartBuckets(points, scale, now = new Date()) {
  const start = scale === "day" ? startOfDay(now) : startOfMonth(now);
  const count = scale === "day" ? 24 : now.getDate();
  const buckets = Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    if (scale === "day") date.setHours(index);
    else date.setDate(index + 1);
    return {
      key: scale === "day" ? hourKey(date) : dayKey(date),
      label: scale === "day"
        ? new Intl.DateTimeFormat("fr-FR", { hour: "2-digit" }).format(date)
        : new Intl.DateTimeFormat("fr-FR", { day: "2-digit" }).format(date),
      values: new Map(),
      total: 0,
    };
  });
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const point of points) {
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const bucket = byKey.get(scale === "day" ? hourKey(date) : dayKey(date));
    if (!bucket) continue;
    bucket.values.set(point.model, (bucket.values.get(point.model) || 0) + point.value);
    bucket.total += point.value;
  }
  return buckets;
}

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfMonth(date) {
  const result = startOfDay(date);
  result.setDate(1);
  return result;
}

function hourKey(date) {
  return `${dayKey(date)}T${String(date.getHours()).padStart(2, "0")}`;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[\";,\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [headers.map(escape).join(";"), ...rows.map((row) => headers.map((header) => escape(row[header])).join(";"))].join("\n");
}

export function filenameDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

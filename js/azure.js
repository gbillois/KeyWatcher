import { mapBudgetsToResources, parseCostQuery, parseMetrics } from "./core.js";

const ARM = "https://management.azure.com";

export class AzureClient {
  constructor(getToken) {
    this.getToken = getToken;
  }

  async request(path, options = {}) {
    const token = this.getToken();
    if (!token) throw new Error("La session Azure a expiré. Reconnectez-vous.");
    const url = path.startsWith("http") ? path : `${ARM}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty response */ }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`;
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  async listSubscriptions() {
    const values = await this.paged("/subscriptions?api-version=2022-12-01");
    return values
      .filter((subscription) => !subscription.state || subscription.state === "Enabled")
      .map((subscription) => ({
        id: subscription.subscriptionId,
        name: subscription.displayName || subscription.subscriptionId,
        state: subscription.state || "Enabled",
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  async listAiAccounts(subscriptionId) {
    const values = await this.paged(`/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.CognitiveServices/accounts?api-version=2025-06-01`);
    return values
      .filter(isActiveAiAccount)
      .map((account) => ({
        id: account.id,
        azureName: account.name,
        subscriptionId,
        resourceGroup: resourceGroupFromId(account.id),
        kind: account.kind || "AI Services",
        location: account.location || "—",
        status: account.properties?.provisioningState || "Succeeded",
        endpoint: account.properties?.endpoint || "",
      }));
  }

  async getSubscriptionCosts(subscriptionId) {
    const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`;
    const baseDataset = {
      granularity: "None",
      grouping: [{ type: "Dimension", name: "ResourceId" }],
    };
    try {
      const payload = await this.request(path, {
        method: "POST",
        body: JSON.stringify({
          type: "ActualCost",
          timeframe: "MonthToDate",
          dataset: { ...baseDataset, aggregation: { totalCost: { name: "Cost", function: "Sum" } } },
        }),
      });
      return parseCostQuery(payload);
    } catch (error) {
      if (error.status !== 400) throw error;
      const payload = await this.request(path, {
        method: "POST",
        body: JSON.stringify({
          type: "Usage",
          timeframe: "MonthToDate",
          dataset: { ...baseDataset, aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } } },
        }),
      });
      return parseCostQuery(payload);
    }
  }

  async getSubscriptionBudgets(subscriptionId) {
    const payload = await this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.CostManagement/budgets?api-version=2025-03-01`);
    return mapBudgetsToResources(payload);
  }

  async getTokenMetrics(resourceId, scale, now = new Date()) {
    const end = new Date(now);
    const start = new Date(now);
    if (scale === "day") start.setHours(0, 0, 0, 0);
    else { start.setDate(1); start.setHours(0, 0, 0, 0); }
    const interval = scale === "day" ? "PT1H" : "P1D";
    const baseParams = new URLSearchParams({
      "api-version": "2023-10-01",
      timespan: `${start.toISOString()}/${end.toISOString()}`,
      interval,
      aggregation: "Total",
    });

    const attempts = [
      { names: "TokenTransaction", filter: "ModelDeploymentName eq '*' and ModelName eq '*'" },
      { names: "TokenTransaction", filter: "ModelDeploymentName eq '*'" },
      { names: "ProcessedPromptTokens,GeneratedTokens", filter: "ModelDeploymentName eq '*' and ModelName eq '*'" },
      { names: "ProcessedPromptTokens,GeneratedTokens", filter: "ModelDeploymentName eq '*'" },
    ];
    let lastError;
    for (const attempt of attempts) {
      const params = new URLSearchParams(baseParams);
      params.set("metricnames", attempt.names);
      params.set("$filter", attempt.filter);
      try {
        const payload = await this.request(`${resourceId}/providers/Microsoft.Insights/metrics?${params}`);
        const points = parseMetrics(payload);
        if (points.length || attempt === attempts.at(-1)) return points;
      } catch (error) {
        lastError = error;
        if (![400, 404].includes(error.status)) throw error;
      }
    }
    throw lastError || new Error("Aucune métrique de jetons disponible pour cette ressource.");
  }

  async paged(path) {
    const result = [];
    let next = path;
    while (next) {
      const payload = await this.request(next);
      result.push(...(payload.value || []));
      next = payload.nextLink || "";
    }
    return result;
  }
}

function isActiveAiAccount(account) {
  const state = String(account?.properties?.provisioningState || "Succeeded").toLowerCase();
  if (["deleting", "failed", "canceled"].includes(state)) return false;
  const kind = String(account?.kind || "").toLowerCase();
  const capabilities = (account?.properties?.capabilities || []).map((item) => String(item?.name || item).toLowerCase());
  return kind.includes("openai")
    || kind.includes("aiservices")
    || capabilities.some((name) => name.includes("openai"))
    || Boolean(account?.properties?.customSubDomainName && account?.properties?.endpoint);
}

function resourceGroupFromId(resourceId) {
  const parts = String(resourceId || "").split("/");
  const index = parts.findIndex((part) => part.toLowerCase() === "resourcegroups");
  return index >= 0 ? parts[index + 1] : "—";
}

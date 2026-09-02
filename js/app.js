import { AzureAuth, currentRedirectUri } from "./auth.js";
import { AzureClient } from "./azure.js";
import {
  STORAGE_KEY,
  chartBuckets,
  defaultConfig,
  filenameDate,
  normalizeConfig,
  percentOf,
  severityForPercent,
  sortRows,
  toCsv,
} from "./core.js";

const COLORS = ["#0f6d8f", "#30c38f", "#7357c7", "#f0a325", "#d9485f", "#18a7a0", "#607d8b", "#ca5faf"];

const state = {
  config: loadConfig(),
  subscriptions: [],
  resources: [],
  sort: { field: "projectName", direction: "asc" },
  search: "",
  selectedResourceId: "",
  scale: "day",
  chartPoints: [],
  chartLoading: false,
  syncing: false,
  lastSync: null,
  notices: [],
};

const auth = new AzureAuth(() => state.config);
const azure = new AzureClient(() => auth.accessToken);
const elements = collectElements();

initialize();

async function initialize() {
  bindEvents();
  elements.tenantIdInput.value = state.config.azure.tenantId;
  elements.clientIdInput.value = state.config.azure.clientId;
  elements.redirectUriInput.value = currentRedirectUri();
  renderAll();

  try {
    const returnedFromMicrosoft = await auth.handleRedirect();
    if (returnedFromMicrosoft) toast("Connexion Microsoft établie.");
  } catch (error) {
    showAuthError(error.message);
    openSettings();
  }

  renderConnection();
  if (auth.isAuthenticated) await synchronize();
}

function bindEvents() {
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.drawerBackdrop.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSettings();
  });

  elements.primaryConnectButton.addEventListener("click", () => {
    if (auth.isAuthenticated) synchronize();
    else openSettings();
  });
  elements.refreshButton.addEventListener("click", synchronize);
  elements.saveSettingsButton.addEventListener("click", saveAzureSettings);
  elements.loginButton.addEventListener("click", async () => {
    try {
      saveAzureSettings(false);
      await auth.login();
    } catch (error) {
      showAuthError(error.message);
    }
  });
  elements.logoutButton.addEventListener("click", () => {
    auth.logout();
    state.resources = [];
    state.subscriptions = [];
    state.selectedResourceId = "";
    state.chartPoints = [];
    renderAll();
    toast("Session locale déconnectée.");
  });
  elements.copyRedirectButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.redirectUriInput.value);
      toast("URI de redirection copiée.");
    } catch {
      elements.redirectUriInput.select();
      toast("Sélectionnez puis copiez l’URI.");
    }
  });

  elements.searchInput.addEventListener("input", () => {
    state.search = elements.searchInput.value.trim().toLowerCase();
    renderResourceTable();
  });
  document.querySelectorAll(".sort-button").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.dataset.sort;
      state.sort.direction = state.sort.field === field && state.sort.direction === "asc" ? "desc" : "asc";
      state.sort.field = field;
      renderResourceTable();
    });
  });
  document.querySelectorAll(".scale-button").forEach((button) => {
    button.addEventListener("click", async () => {
      state.scale = button.dataset.scale;
      document.querySelectorAll(".scale-button").forEach((item) => item.classList.toggle("is-active", item === button));
      if (state.selectedResourceId) await loadChart();
      else renderChart();
    });
  });

  elements.exportConfigButton.addEventListener("click", exportProjects);
  elements.importConfigButton.addEventListener("click", () => elements.importConfigInput.click());
  elements.importConfigInput.addEventListener("change", importProjects);
  elements.exportConsumptionButton.addEventListener("click", () => exportConsumption("csv"));
  elements.exportConsumptionJsonButton.addEventListener("click", () => exportConsumption("json"));
}

async function synchronize() {
  if (state.syncing) return;
  if (!auth.isAuthenticated) {
    openSettings();
    showAuthError("Connectez votre compte Microsoft pour actualiser les données.");
    return;
  }

  state.syncing = true;
  state.notices = [];
  renderConnection();
  renderNotice("Synchronisation avec Azure en cours…", false);

  try {
    state.subscriptions = await azure.listSubscriptions();
    renderSubscriptions();
    const selected = state.config.azure.selectedSubscriptions;
    const subscriptions = selected.length
      ? state.subscriptions.filter((subscription) => selected.includes(subscription.id))
      : state.subscriptions;

    const bundles = await Promise.all(subscriptions.map(loadSubscriptionBundle));
    const resources = [];
    for (const bundle of bundles) {
      state.notices.push(...bundle.notices);
      for (const account of bundle.accounts) {
        const id = account.id.toLowerCase();
        const project = state.config.projects[id] || {};
        const costInfo = bundle.costs.get(id) || { cost: null, currency: project.currency || "EUR" };
        const azureBudget = bundle.budgets.get(id);
        const localBudget = Number(project.budget || 0);
        const budget = localBudget > 0 ? localBudget : Number(azureBudget?.amount || 0);
        const currency = costInfo.currency || azureBudget?.currency || project.currency || "EUR";
        const cost = costInfo.cost;
        resources.push({
          ...account,
          projectName: project.name || account.azureName,
          budget,
          localBudget,
          azureBudgetAmount: Number(azureBudget?.amount || 0),
          budgetSource: localBudget > 0 ? "local" : azureBudget ? "azure" : "none",
          azureBudgetName: azureBudget?.name || "",
          cost,
          currency,
          percent: cost === null ? null : percentOf(cost, budget),
        });
      }
    }
    state.resources = resources;
    state.lastSync = new Date();
    if (state.selectedResourceId && !resources.some((resource) => resource.id === state.selectedResourceId)) {
      state.selectedResourceId = "";
      state.chartPoints = [];
    }
    renderAll();
    if (state.notices.length) toast(state.notices[0], true);
    else toast(`${resources.length} ressource${resources.length > 1 ? "s" : ""} IA synchronisée${resources.length > 1 ? "s" : ""}.`);
  } catch (error) {
    renderNotice(friendlyAzureError(error), true);
    toast(friendlyAzureError(error), true);
  } finally {
    state.syncing = false;
    renderConnection();
  }
}

async function loadSubscriptionBundle(subscription) {
  const notices = [];
  let accounts = [];
  let costs = new Map();
  let budgets = new Map();

  try {
    accounts = await azure.listAiAccounts(subscription.id);
  } catch (error) {
    notices.push(`${subscription.name} : ressources illisibles (${shortError(error)}).`);
    return { accounts, costs, budgets, notices };
  }

  const [costResult, budgetResult] = await Promise.allSettled([
    azure.getSubscriptionCosts(subscription.id),
    azure.getSubscriptionBudgets(subscription.id),
  ]);
  if (costResult.status === "fulfilled") costs = costResult.value;
  else notices.push(`${subscription.name} : coûts indisponibles, vérifiez le rôle Cost Management Reader.`);
  if (budgetResult.status === "fulfilled") budgets = budgetResult.value;
  else notices.push(`${subscription.name} : budgets Azure indisponibles ; les budgets locaux restent utilisables.`);
  return { accounts, costs, budgets, notices };
}

function renderAll() {
  renderConnection();
  renderSummary();
  renderResourceTable();
  renderChart();
  renderSubscriptions();
  renderLastSync();
}

function renderConnection() {
  elements.connectionBadge.classList.toggle("is-online", auth.isAuthenticated && !state.syncing);
  elements.connectionBadge.classList.toggle("is-loading", state.syncing);
  elements.connectionBadge.classList.toggle("is-offline", !auth.isAuthenticated);
  elements.connectionBadge.lastChild.textContent = state.syncing
    ? " Synchronisation"
    : auth.isAuthenticated
      ? ` ${auth.accountLabel}`
      : " Non connecté";
  elements.refreshButton.disabled = !auth.isAuthenticated || state.syncing;
  elements.loginButton.hidden = auth.isAuthenticated;
  elements.logoutButton.hidden = !auth.isAuthenticated;
  elements.primaryConnectButton.textContent = auth.isAuthenticated ? "Actualiser les données" : "Configurer Azure";
}

function renderSummary() {
  const resources = state.resources;
  const costs = resources.filter((item) => item.cost !== null);
  const costTotal = costs.reduce((sum, item) => sum + item.cost, 0);
  const budgetTotal = resources.reduce((sum, item) => sum + item.budget, 0);
  const attention = resources.filter((item) => item.percent !== null && item.percent >= 75).length;
  const currency = mostCommonCurrency(resources) || "EUR";
  elements.resourceCount.textContent = auth.isAuthenticated ? String(resources.length) : "—";
  elements.monthCost.textContent = costs.length ? formatMoney(costTotal, currency) : "—";
  elements.totalBudget.textContent = budgetTotal ? formatMoney(budgetTotal, currency) : "—";
  elements.attentionCount.textContent = auth.isAuthenticated ? String(attention) : "—";
}

function renderResourceTable() {
  elements.resourceTableBody.replaceChildren();
  document.querySelectorAll(".sort-button").forEach((button) => {
    const active = button.dataset.sort === state.sort.field;
    button.classList.toggle("is-active", active);
    button.querySelector("span").textContent = active ? (state.sort.direction === "asc" ? "↑" : "↓") : "↕";
  });

  if (!auth.isAuthenticated) {
    elements.resourceTable.hidden = true;
    renderNotice("Commencez par connecter Azure. KeyWatcher découvrira automatiquement vos ressources Azure AI actives.");
    return;
  }
  if (state.syncing && !state.resources.length) {
    elements.resourceTable.hidden = true;
    renderNotice("Synchronisation avec Azure en cours…");
    return;
  }
  if (!state.resources.length) {
    elements.resourceTable.hidden = true;
    renderNotice("Aucune ressource Foundry ou Azure OpenAI active n’a été trouvée dans les abonnements suivis.");
    return;
  }

  const filtered = state.resources.filter((resource) => [resource.projectName, resource.azureName, resource.resourceGroup, resource.kind]
    .some((value) => String(value || "").toLowerCase().includes(state.search)));
  const sortable = filtered.map((resource) => ({
    ...resource,
    statusRank: statusRank(resource),
  }));
  const sortField = state.sort.field === "status" ? "statusRank" : state.sort.field;
  const sorted = sortRows(sortable, sortField, state.sort.direction);

  elements.tableNotice.hidden = true;
  elements.resourceTable.hidden = false;
  for (const resource of sorted) elements.resourceTableBody.append(createResourceRow(resource));
}

function createResourceRow(resource) {
  const row = document.createElement("tr");
  row.classList.toggle("is-selected", resource.id === state.selectedResourceId);
  row.tabIndex = 0;
  row.setAttribute("aria-label", `Afficher la consommation de ${resource.projectName}`);
  row.addEventListener("click", () => selectResource(resource.id));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectResource(resource.id);
    }
  });

  const projectCell = document.createElement("td");
  const projectInput = document.createElement("input");
  projectInput.className = "project-input";
  projectInput.value = resource.projectName;
  projectInput.setAttribute("aria-label", `Nom du projet pour ${resource.azureName}`);
  projectInput.addEventListener("click", stopPropagation);
  projectInput.addEventListener("keydown", stopPropagation);
  projectInput.addEventListener("change", () => updateProject(resource, { name: projectInput.value.trim() || resource.azureName }));
  projectCell.append(projectInput);

  const azureCell = document.createElement("td");
  const azureBlock = document.createElement("div");
  azureBlock.className = "azure-resource";
  const azureName = document.createElement("strong");
  azureName.textContent = resource.azureName;
  const azureMeta = document.createElement("span");
  azureMeta.textContent = `${resource.resourceGroup} · ${resource.location} · ${resource.kind}`;
  azureBlock.append(azureName, azureMeta);
  azureCell.append(azureBlock);

  const budgetCell = document.createElement("td");
  const budgetBlock = document.createElement("div");
  budgetBlock.className = "budget-cell";
  const budgetInput = document.createElement("input");
  budgetInput.className = "budget-input";
  budgetInput.type = "number";
  budgetInput.min = "0";
  budgetInput.step = "1";
  budgetInput.placeholder = resource.budgetSource === "azure" ? String(resource.budget) : "0";
  budgetInput.value = resource.localBudget > 0 ? String(resource.localBudget) : "";
  budgetInput.setAttribute("aria-label", `Budget local pour ${resource.projectName}`);
  budgetInput.addEventListener("click", stopPropagation);
  budgetInput.addEventListener("keydown", stopPropagation);
  budgetInput.addEventListener("change", () => updateProject(resource, { budget: Math.max(0, Number(budgetInput.value) || 0) }));
  const budgetSource = document.createElement("span");
  budgetSource.className = "budget-source";
  budgetSource.textContent = resource.budgetSource === "azure"
    ? `${formatMoney(resource.budget, resource.currency)} · Azure`
    : resource.budgetSource === "local"
      ? `${formatMoney(resource.budget, resource.currency)} · local`
      : `Budget local · ${resource.currency}`;
  budgetBlock.append(budgetInput, budgetSource);
  budgetCell.append(budgetBlock);

  const severity = severityForPercent(resource.percent);
  const costCell = document.createElement("td");
  const cost = document.createElement("span");
  cost.className = `money ${severity === "normal" ? "" : `is-${severity}`}`;
  cost.textContent = resource.cost === null ? "Indisponible" : formatMoney(resource.cost, resource.currency);
  costCell.append(cost);

  const percentCell = document.createElement("td");
  const utilization = document.createElement("div");
  utilization.className = "utilization";
  const track = document.createElement("div");
  track.className = "progress-track";
  const value = document.createElement("div");
  value.className = `progress-value ${severity === "normal" ? "" : `is-${severity}`}`;
  value.style.width = `${Math.min(100, Math.max(0, resource.percent || 0))}%`;
  track.append(value);
  const percentText = document.createElement("span");
  percentText.className = `percentage-text ${severity === "normal" ? "" : `is-${severity}`}`;
  percentText.textContent = resource.percent === null ? "—" : `${formatNumber(resource.percent, 1)} %`;
  utilization.append(track, percentText);
  percentCell.append(utilization);

  const statusCell = document.createElement("td");
  const status = document.createElement("span");
  const active = String(resource.status).toLowerCase() === "succeeded";
  status.className = `state-pill${active ? "" : " is-unknown"}`;
  status.textContent = active ? "Active" : resource.status;
  statusCell.append(status);

  row.append(projectCell, azureCell, budgetCell, costCell, percentCell, statusCell);
  return row;
}

function updateProject(resource, changes) {
  const id = resource.id.toLowerCase();
  const existing = state.config.projects[id] || { name: resource.azureName, budget: 0, currency: resource.currency };
  state.config.projects[id] = { ...existing, ...changes, currency: resource.currency };
  saveConfig();
  const target = state.resources.find((item) => item.id === resource.id);
  if (target) {
    target.projectName = state.config.projects[id].name || target.azureName;
    target.localBudget = state.config.projects[id].budget || 0;
    target.budget = target.localBudget || target.azureBudgetAmount || 0;
    target.budgetSource = target.localBudget > 0 ? "local" : target.azureBudgetName ? "azure" : "none";
    target.percent = target.cost === null ? null : percentOf(target.cost, target.budget);
  }
  renderSummary();
  renderResourceTable();
  if (changes.name !== undefined) renderChartHeading();
  toast("Projet enregistré dans ce navigateur.");
}

async function selectResource(resourceId) {
  if (state.selectedResourceId === resourceId && state.chartPoints.length) return;
  state.selectedResourceId = resourceId;
  renderResourceTable();
  await loadChart();
}

async function loadChart() {
  const resource = state.resources.find((item) => item.id === state.selectedResourceId);
  if (!resource) return;
  state.chartLoading = true;
  state.chartPoints = [];
  renderChart();
  try {
    state.chartPoints = await azure.getTokenMetrics(resource.id, state.scale);
  } catch (error) {
    state.chartPoints = [];
    toast(`Métriques indisponibles : ${shortError(error)}`, true);
  } finally {
    state.chartLoading = false;
    renderChart();
  }
}

function renderChart() {
  renderChartHeading();
  elements.chartLegend.replaceChildren();
  elements.chartBars.replaceChildren();
  const resource = state.resources.find((item) => item.id === state.selectedResourceId);

  if (!resource || state.chartLoading || !state.chartPoints.length) {
    elements.chartContent.hidden = true;
    elements.chartEmpty.hidden = false;
    const mark = elements.chartEmpty.querySelector(".chart-empty-mark");
    const title = elements.chartEmpty.querySelector("strong");
    const detail = elements.chartEmpty.querySelector("span:last-child");
    if (state.chartLoading) {
      mark.textContent = "◌";
      title.textContent = "Chargement des métriques";
      detail.textContent = "Azure Monitor prépare la série de jetons.";
    } else if (resource) {
      mark.textContent = "▥";
      title.textContent = "Aucune consommation disponible";
      detail.textContent = "La ressource ne publie peut-être pas de métriques de jetons sur cette période.";
    } else {
      mark.textContent = "▥";
      title.textContent = "Aucune ressource sélectionnée";
      detail.textContent = "Cliquez sur une ligne du tableau pour charger la consommation.";
    }
    return;
  }

  elements.chartEmpty.hidden = true;
  elements.chartContent.hidden = false;
  const models = [...new Set(state.chartPoints.map((point) => point.model))].sort((a, b) => a.localeCompare(b, "fr"));
  const colorByModel = new Map(models.map((model, index) => [model, COLORS[index % COLORS.length]]));
  for (const model of models) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = colorByModel.get(model);
    const label = document.createElement("span");
    label.textContent = model;
    item.append(swatch, label);
    elements.chartLegend.append(item);
  }

  const buckets = chartBuckets(state.chartPoints, state.scale);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  buckets.forEach((bucket, index) => {
    const column = document.createElement("div");
    column.className = "bar-column";
    const stack = document.createElement("div");
    stack.className = "bar-stack";
    stack.style.height = `${Math.max(bucket.total ? 2 : 0, (bucket.total / max) * 100)}%`;
    for (const model of models) {
      const amount = bucket.values.get(model) || 0;
      if (!amount) continue;
      const segment = document.createElement("div");
      segment.className = "bar-segment";
      segment.style.height = `${(amount / bucket.total) * 100}%`;
      segment.style.background = colorByModel.get(model);
      segment.title = `${bucket.label} · ${model} : ${formatCompact(amount)} jetons`;
      stack.append(segment);
    }
    const label = document.createElement("span");
    label.className = "bar-label";
    const showEvery = state.scale === "day" ? 3 : Math.max(1, Math.ceil(buckets.length / 11));
    label.textContent = index % showEvery === 0 || index === buckets.length - 1 ? bucket.label : "";
    column.append(stack, label);
    elements.chartBars.append(column);
  });
}

function renderChartHeading() {
  const resource = state.resources.find((item) => item.id === state.selectedResourceId);
  elements.chartTitle.textContent = resource ? `Consommation · ${resource.projectName}` : "Consommation par modèle";
  elements.chartSubtitle.textContent = resource
    ? `${state.scale === "day" ? "Aujourd’hui, heure par heure" : "Mois en cours, jour par jour"} · jetons traités`
    : "Sélectionnez une ressource pour afficher ses jetons.";
}

function renderSubscriptions() {
  elements.subscriptionList.replaceChildren();
  if (!state.subscriptions.length) {
    const message = document.createElement("span");
    message.className = "muted";
    message.textContent = auth.isAuthenticated ? "Aucun abonnement accessible." : "Connectez Azure pour afficher les abonnements.";
    elements.subscriptionList.append(message);
    return;
  }
  const selected = state.config.azure.selectedSubscriptions;
  for (const subscription of state.subscriptions) {
    const label = document.createElement("label");
    label.className = "subscription-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !selected.length || selected.includes(subscription.id);
    const text = document.createElement("span");
    const name = document.createElement("span");
    name.textContent = subscription.name;
    const id = document.createElement("small");
    id.textContent = subscription.id;
    text.append(name, id);
    label.append(input, text);
    input.addEventListener("change", async () => {
      const checked = [...elements.subscriptionList.querySelectorAll("input:checked")];
      if (!checked.length) {
        input.checked = true;
        toast("Conservez au moins un abonnement suivi.", true);
        return;
      }
      state.config.azure.selectedSubscriptions = checked.length === state.subscriptions.length
        ? []
        : checked.map((item) => item.closest("label").querySelector("small").textContent);
      saveConfig();
      await synchronize();
    });
    elements.subscriptionList.append(label);
  }
}

function renderNotice(message, isError = false) {
  elements.tableNotice.hidden = false;
  elements.tableNotice.classList.toggle("is-error", isError);
  elements.tableNotice.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = isError ? "Synchronisation incomplète." : message.split(". ")[0];
  const detail = document.createElement("span");
  detail.textContent = isError ? message : message.includes(". ") ? message.slice(message.indexOf(". ") + 2) : "";
  elements.tableNotice.append(strong, detail);
}

function renderLastSync() {
  elements.lastSyncLabel.textContent = state.lastSync
    ? `Dernière synchronisation à ${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(state.lastSync)}`
    : "Aucune synchronisation";
}

function saveAzureSettings(showToast = true) {
  const tenantId = elements.tenantIdInput.value.trim() || "organizations";
  const clientId = elements.clientIdInput.value.trim();
  if (clientId && !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error("L’identifiant de l’application doit être un GUID Azure valide.");
  state.config.azure.tenantId = tenantId;
  state.config.azure.clientId = clientId;
  saveConfig();
  elements.tenantIdInput.value = tenantId;
  showAuthError("");
  if (showToast) toast("Configuration Azure enregistrée localement.");
}

function exportProjects() {
  const payload = {
    product: "KeyWatcher",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    projects: state.config.projects,
  };
  downloadBlob(JSON.stringify(payload, null, 2), `keywatcher-projets-${filenameDate()}.json`, "application/json");
}

async function importProjects(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const projects = payload.projects || payload?.config?.projects;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw new Error("Ce fichier ne contient pas de projets KeyWatcher.");
    const imported = normalizeConfig({ ...defaultConfig(), projects });
    state.config.projects = { ...state.config.projects, ...imported.projects };
    saveConfig();
    for (const resource of state.resources) {
      const project = state.config.projects[resource.id.toLowerCase()];
      if (!project) continue;
      resource.projectName = project.name || resource.azureName;
      resource.localBudget = project.budget || 0;
      if (resource.localBudget) {
        resource.budget = resource.localBudget;
        resource.budgetSource = "local";
      }
      resource.percent = resource.cost === null ? null : percentOf(resource.cost, resource.budget);
    }
    renderAll();
    toast("Projets importés et fusionnés.");
  } catch (error) {
    toast(error.message || "Import JSON impossible.", true);
  }
}

function exportConsumption(format) {
  if (!state.resources.length) {
    toast("Synchronisez Azure avant d’exporter les consommations.", true);
    return;
  }
  const exportedAt = new Date().toISOString();
  const rows = state.resources.map((resource) => ({
    exportedAt,
    periode: "mois_en_cours",
    projet: resource.projectName,
    ressourceAzure: resource.azureName,
    resourceId: resource.id,
    abonnement: resource.subscriptionId,
    cout: resource.cost,
    devise: resource.currency,
    budget: resource.budget,
    pourcentage: resource.percent,
  }));
  const selected = state.resources.find((resource) => resource.id === state.selectedResourceId);
  for (const point of state.chartPoints) {
    rows.push({
      exportedAt,
      periode: state.scale,
      projet: selected?.projectName || "",
      ressourceAzure: selected?.azureName || "",
      resourceId: selected?.id || "",
      abonnement: selected?.subscriptionId || "",
      modele: point.model,
      horodatage: point.timestamp,
      jetons: point.value,
    });
  }
  const date = filenameDate();
  if (format === "json") downloadBlob(JSON.stringify(rows, null, 2), `keywatcher-consommations-${date}.json`, "application/json");
  else downloadBlob(`\ufeff${toCsv(rows)}`, `keywatcher-consommations-${date}.csv`, "text/csv;charset=utf-8");
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return defaultConfig();
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
}

function openSettings() {
  elements.settingsDrawer.classList.add("is-open");
  elements.settingsDrawer.setAttribute("aria-hidden", "false");
  elements.settingsButton.setAttribute("aria-expanded", "true");
  elements.drawerBackdrop.hidden = false;
  setTimeout(() => elements.closeSettingsButton.focus(), 0);
}

function closeSettings() {
  elements.settingsDrawer.classList.remove("is-open");
  elements.settingsDrawer.setAttribute("aria-hidden", "true");
  elements.settingsButton.setAttribute("aria-expanded", "false");
  elements.drawerBackdrop.hidden = true;
}

function showAuthError(message) {
  elements.authHelp.textContent = message || "Le navigateur réutilisera normalement votre session Microsoft existante.";
  elements.authHelp.classList.toggle("is-error", Boolean(message));
}

function toast(message, isError = false) {
  const item = document.createElement("div");
  item.className = `toast${isError ? " is-error" : ""}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 5200);
}

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatMoney(value, currency = "EUR") {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency || "EUR", maximumFractionDigits: 2 }).format(value || 0);
  } catch {
    return `${formatNumber(value, 2)} ${currency}`;
  }
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(value || 0);
}

function formatCompact(value) {
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function mostCommonCurrency(resources) {
  const counts = new Map();
  for (const resource of resources) counts.set(resource.currency, (counts.get(resource.currency) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function statusRank(resource) {
  const severity = severityForPercent(resource.percent);
  if (severity === "danger") return 3;
  if (severity === "warning") return 2;
  return String(resource.status).toLowerCase() === "succeeded" ? 0 : 1;
}

function friendlyAzureError(error) {
  if (error.status === 401) return "La session Azure a expiré. Déconnectez puis reconnectez le compte Microsoft.";
  if (error.status === 403) return "Azure refuse l’accès. Vérifiez les rôles Reader et Cost Management Reader sur l’abonnement.";
  if (error.message?.includes("Failed to fetch")) return "Le navigateur n’a pas pu joindre Azure. Vérifiez la connexion et l’URI SPA de l’application Entra.";
  return `Azure n’a pas pu être synchronisé : ${shortError(error)}.`;
}

function shortError(error) {
  const message = String(error?.message || error || "erreur inconnue").replace(/\s+/g, " ").trim();
  return message.length > 150 ? `${message.slice(0, 147)}…` : message;
}

function stopPropagation(event) {
  event.stopPropagation();
}

function collectElements() {
  return Object.fromEntries([
    "connectionBadge", "refreshButton", "settingsButton", "primaryConnectButton", "lastSyncLabel",
    "resourceCount", "monthCost", "totalBudget", "attentionCount", "searchInput", "tableNotice",
    "resourceTable", "resourceTableBody", "chartTitle", "chartSubtitle", "chartEmpty", "chartContent",
    "chartLegend", "chartBars", "drawerBackdrop", "settingsDrawer", "closeSettingsButton", "tenantIdInput",
    "clientIdInput", "redirectUriInput", "copyRedirectButton", "saveSettingsButton", "loginButton", "logoutButton",
    "authHelp", "subscriptionList", "exportConfigButton", "importConfigButton", "exportConsumptionButton",
    "exportConsumptionJsonButton", "importConfigInput", "toastRegion",
  ].map((id) => [id, document.getElementById(id)]));
}

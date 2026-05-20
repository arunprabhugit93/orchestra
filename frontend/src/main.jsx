import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchJson } from "./api/client";
import { DATA_VIEWS, EMPTY_AGENT_FORM, EVENT_LABELS, TRACE_FILTERS } from "./domain/constants";
import { formatCost, formatDate, formatDuration, formatPayloadValue, shortId } from "./utils/formatters";
import { WS_URL } from "./config";
import "../styles.css";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="settings-error">
          {this.props.label || "Something went wrong"}: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [connectionStatus, setConnectionStatus] = useState("Connecting");
  const [mode, setMode] = useState("agents");
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [runs, setRuns] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRunAgentId, setSelectedRunAgentId] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedView, setSelectedView] = useState("transactions");
  const [filter, setFilter] = useState("");
  const [agentDialog, setAgentDialog] = useState({ open: false, mode: "create", agent: null });
  const [agentForm, setAgentForm] = useState(EMPTY_AGENT_FORM);
  const [formError, setFormError] = useState("");
  const [pageError, setPageError] = useState("");

  const selectedAgent = agents.find((agent) => agent.agent_id === selectedAgentId) || null;
  const selectedRun = runs.find((run) => run.run_id === selectedRunId && run.agent_id === selectedRunAgentId) || null;
  const visibleEvents = useMemo(() => events.filter((event) => eventMatchesView(event, selectedView)), [events, selectedView]);
  const filteredRuns = useMemo(() => filterRuns(runs, filter), [runs, filter]);
  const costBreakdown = useMemo(() => calculateCostBreakdown(events), [events]);
  const selectedEvent = useMemo(
    () => events.find((event) => event.event_id === selectedEventId) || visibleEvents.at(-1) || null,
    [events, selectedEventId, visibleEvents],
  );

  useEffect(() => {
    loadAgents();
  }, []);

  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    socket.addEventListener("open", () => setConnectionStatus("Live"));
    socket.addEventListener("error", () => setConnectionStatus("Offline"));
    socket.addEventListener("close", () => setConnectionStatus("Offline"));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(message.data);
      if (event.run_id === selectedRunId && event.agent_id === selectedRunAgentId) {
        setEvents((current) => dedupeEvents([...current, event]));
        setSelectedEventId(event.event_id);
      }
    });
    return () => socket.close();
  }, [selectedRunId, selectedRunAgentId]);

  async function loadAgents() {
    try {
      const data = await fetchJson("/agents");
      setAgents(data);
      setPageError("");
    } catch (error) {
      setPageError(error.message);
      setConnectionStatus("API error");
    }
  }

  async function openAgent(agentId) {
    setMode("agent_detail");
    setSelectedAgentId(agentId);
    setSelectedView("transactions");
    setSelectedRunId("");
    setSelectedRunAgentId("");
    setSelectedEventId("");
    setEvents([]);
    await loadRuns(agentId, { keepTransactionsView: true });
  }

  async function loadRuns(agentId = selectedAgentId, options = {}) {
    if (!agentId) return;
    const data = await fetchJson(`/runs?limit=500&agent_id=${encodeURIComponent(agentId)}`);
    setRuns(data);
    const run = data.find((item) => item.run_id === selectedRunId && item.agent_id === selectedRunAgentId) || data[0];
    if (run) {
      await preloadRunEvents(run, { switchToAll: !options.keepTransactionsView });
    } else {
      setEvents([]);
      setSelectedRunId("");
      setSelectedRunAgentId("");
      setSelectedEventId("");
    }
  }

  async function preloadRunEvents(run, options = {}) {
    const data = await fetchJson(`/runs/${encodeURIComponent(run.run_id)}/events?agent_id=${encodeURIComponent(run.agent_id)}`);
    const deduped = dedupeEvents(data);
    setSelectedRunId(run.run_id);
    setSelectedRunAgentId(run.agent_id);
    setEvents(deduped);
    setSelectedEventId(deduped.at(-1)?.event_id || "");
    if (options.switchToAll) setSelectedView("all");
  }

  async function refreshCurrentView() {
    await loadAgents();
    if (mode === "agent_detail" && selectedAgentId) {
      await loadRuns(selectedAgentId, { keepTransactionsView: selectedView === "transactions" });
    }
  }

  function openSettings() {
    setMode("settings");
  }

  async function importLangfuse() {
    if (!selectedAgentId) return;
    setConnectionStatus("Importing");
    await fetchJson(`/agents/${encodeURIComponent(selectedAgentId)}/import-langfuse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 100, max_pages: 2 }),
    });
    await loadRuns(selectedAgentId, { keepTransactionsView: true });
    setConnectionStatus("Live");
  }

  function backToAgents() {
    setMode("agents");
    setRuns([]);
    setEvents([]);
    setSelectedRunId("");
    setSelectedRunAgentId("");
    setSelectedEventId("");
    setSelectedView("transactions");
  }

  function openCreateDialog() {
    setFormError("");
    setAgentForm(EMPTY_AGENT_FORM);
    setAgentDialog({ open: true, mode: "create", agent: null });
  }

  function openEditDialog(agent) {
    setFormError("");
    setAgentForm({
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      base_url: agent.base_url,
      public_key: "",
      secret_key: "",
    });
    setAgentDialog({ open: true, mode: "edit", agent });
  }

  async function saveAgent(event) {
    event.preventDefault();
    setFormError("");
    const editing = agentDialog.mode === "edit";
    const displayName = agentForm.display_name.trim();
    const baseUrl = agentForm.base_url.trim();
    const publicKey = agentForm.public_key.trim();
    const secretKey = agentForm.secret_key.trim();
    if (!displayName) {
      setFormError("Display name is required.");
      return;
    }
    if (!baseUrl) {
      setFormError("Langfuse base URL is required.");
      return;
    }
    if (!editing && (!publicKey || !secretKey)) {
      setFormError("Public key and secret key are required when adding an agent.");
      return;
    }
    const payload = {
      display_name: displayName,
      provider: "langfuse",
      base_url: baseUrl,
      metadata: editing ? agentDialog.agent?.metadata || {} : {},
    };
    if (publicKey) payload.public_key = publicKey;
    if (secretKey) payload.secret_key = secretKey;

    try {
      const saved = await fetchJson(editing ? `/agents/${encodeURIComponent(agentForm.agent_id)}` : "/agents", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedAgentId(saved.agent_id);
      setAgentDialog({ open: false, mode: "create", agent: null });
      await loadAgents();
    } catch (error) {
      setFormError(error.message);
    }
  }

  async function deleteAgent(agent) {
    if (!window.confirm(`Delete ${agent.display_name}? Stored credentials will be removed.`)) return;
    await fetchJson(`/agents/${encodeURIComponent(agent.agent_id)}`, { method: "DELETE" });
    if (selectedAgentId === agent.agent_id) backToAgents();
    await loadAgents();
  }

  const metrics = selectedRunMetrics(selectedRun, events, costBreakdown);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <h1>Agent Monitor</h1>
            <p>{connectionStatus}</p>
          </div>
          <button className="icon-button" type="button" onClick={refreshCurrentView} title="Refresh" aria-label="Refresh">
            R
          </button>
        </header>
        <nav className="module-nav" aria-label="Modules">
          <button className={`module-item ${mode !== "settings" ? "active" : ""}`} type="button" onClick={backToAgents}>
            <span>Agents</span>
            <small>Onboard and monitor</small>
          </button>
          <button className={`module-item ${mode === "settings" ? "active" : ""}`} type="button" onClick={openSettings}>
            <span>Settings</span>
            <small>Organization master data</small>
          </button>
        </nav>
      </aside>

      <main className="main-panel">
        <section className="topbar">
          <div>
            <div className="eyebrow">Module</div>
            <h2>{mode === "agent_detail" ? "Agent Detail" : mode === "settings" ? "Settings" : "Agents"}</h2>
          </div>
          <div className="topbar-actions">
            {mode === "agent_detail" && (
              <>
                <select className="agent-select" value={selectedAgentId} onChange={(event) => openAgent(event.target.value)}>
                  {agents.map((agent) => (
                    <option key={agent.agent_id} value={agent.agent_id}>
                      {agent.display_name} ({agent.agent_id})
                    </option>
                  ))}
                </select>
                <button className="command-button" type="button" onClick={backToAgents}>
                  Agents
                </button>
                <button className="command-button" type="button" onClick={importLangfuse}>
                  <span aria-hidden="true">v</span>
                  Import Langfuse
                </button>
              </>
            )}
            {mode !== "settings" && (
              <button className="command-button" type="button" onClick={openCreateDialog}>
                <span aria-hidden="true">+</span>
                Add Agent
              </button>
            )}
          </div>
        </section>

        {mode === "settings" ? (
          <ErrorBoundary label="Settings failed to render">
            <SettingsModule />
          </ErrorBoundary>
        ) : mode === "agents" ? (
          <AgentRegistry
            agents={agents}
            pageError={pageError}
            selectedAgentId={selectedAgentId}
            onView={openAgent}
            onEdit={openEditDialog}
            onDelete={deleteAgent}
          />
        ) : (
          <AgentDetail
            selectedAgent={selectedAgent}
            selectedRun={selectedRun}
            runs={filteredRuns}
            events={events}
            visibleEvents={visibleEvents}
            selectedView={selectedView}
            selectedEvent={selectedEvent}
            selectedEventId={selectedEventId}
            metrics={metrics}
            costBreakdown={costBreakdown}
            filter={filter}
            onFilter={setFilter}
            onSelectView={(viewId) => {
              setSelectedView(viewId);
              if (viewId !== "transactions") setSelectedEventId(events.filter((event) => eventMatchesView(event, viewId)).at(-1)?.event_id || "");
            }}
            onSelectRun={(run) => preloadRunEvents(run, { switchToAll: true })}
            onSelectEvent={setSelectedEventId}
          />
        )}
      </main>

      {agentDialog.open && (
        <AgentDialog
          mode={agentDialog.mode}
          form={agentForm}
          error={formError}
          onChange={(patch) => setAgentForm((current) => ({ ...current, ...patch }))}
          onClose={() => setAgentDialog({ open: false, mode: "create", agent: null })}
          onSubmit={saveAgent}
        />
      )}
    </div>
  );
}

function AgentRegistry({ agents, pageError, selectedAgentId, onView, onEdit, onDelete }) {
  const [query, setQuery] = useState("");
  const visibleAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return agents;
    return agents.filter((agent) =>
      [agent.agent_id, agent.display_name, agent.provider, agent.base_url].filter(Boolean).join(" ").toLowerCase().includes(normalized),
    );
  }, [agents, query]);
  const connectedCount = agents.filter((agent) => agent.secret_key_configured).length;

  return (
    <section className="agent-admin">
      <div className="agent-hero">
        <div>
          <span className="eyebrow">Registry</span>
          <h3>Agent Registry</h3>
          <p>Manage Langfuse-backed agents, credential status, and monitoring access.</p>
        </div>
        <div className="agent-hero-metrics">
          <div>
            <span>Total agents</span>
            <strong>{agents.length}</strong>
          </div>
          <div>
            <span>Credentials ready</span>
            <strong>{connectedCount}</strong>
          </div>
          <div>
            <span>Needs setup</span>
            <strong>{Math.max(0, agents.length - connectedCount)}</strong>
          </div>
        </div>
      </div>

      <div className="agent-list-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search agents, providers, or URLs..."
          aria-label="Search agents"
        />
        <span>{visibleAgents.length} shown</span>
      </div>

      {pageError && <div className="empty-state">Could not load agents: {pageError}</div>}
      {!pageError && !agents.length && <div className="empty-state">No agents onboarded</div>}
      {!pageError && agents.length > 0 && !visibleAgents.length && <div className="empty-state">No agents match the current search.</div>}

      <div className="agent-card-grid">
        {visibleAgents.map((agent) => (
          <article key={agent.agent_id} className={`agent-card ${agent.agent_id === selectedAgentId ? "active" : ""}`}>
            <div className="agent-card-header">
              <div className="agent-avatar">{agentInitials(agent)}</div>
              <div>
                <h4>{agent.display_name || agent.agent_id}</h4>
                <code>{agent.agent_id}</code>
              </div>
            </div>
            <div className="agent-card-meta">
              <span className="provider-pill">{agent.provider}</span>
              <span className={`credential-pill ${agent.secret_key_configured ? "ready" : "missing"}`}>
                {agent.secret_key_configured ? "Credentials encrypted" : "Credentials missing"}
              </span>
            </div>
            <dl className="agent-card-details">
              <div>
                <dt>Base URL</dt>
                <dd title={agent.base_url}>{agent.base_url}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatDate(agent.updated_at)}</dd>
              </div>
            </dl>
            <div className="agent-card-actions">
              <button className="command-button primary" type="button" onClick={() => onView(agent.agent_id)}>
                View
              </button>
              <button className="mini-button" type="button" onClick={() => onEdit(agent)}>
                Edit
              </button>
              <button className="mini-button danger" type="button" onClick={() => onDelete(agent)}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AgentDialog({ mode, form, error, onChange, onClose, onSubmit }) {
  const editing = mode === "edit";
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="agent-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
        <form onSubmit={onSubmit}>
          <div className="dialog-header">
            <div>
              <h3 id="agent-dialog-title">{editing ? "Edit Agent" : "Add Agent"}</h3>
              <p>{editing ? "Update display details or rotate credentials." : "Connect a Langfuse-backed agent for monitoring."}</p>
            </div>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
              x
            </button>
          </div>

          {editing && (
            <div className="readonly-field">
              <span>Agent ID</span>
              <code>{form.agent_id}</code>
            </div>
          )}

          <div className="dialog-grid single">
            <label>
              Display name
              <input
                value={form.display_name}
                onChange={(event) => onChange({ display_name: event.target.value })}
                placeholder="Claims Agent Production"
                required
              />
            </label>
          </div>

          <label>
            Langfuse base URL
            <input
              value={form.base_url}
              onChange={(event) => onChange({ base_url: event.target.value })}
              placeholder="https://hipaa.cloud.langfuse.com"
              required
            />
          </label>

          <div className="dialog-grid">
            <label>
              Public key
              <input
                value={form.public_key}
                onChange={(event) => onChange({ public_key: event.target.value })}
                placeholder={editing ? "Leave blank to keep current key" : "pk-lf-..."}
                required={!editing}
              />
            </label>
            <label>
              Secret key
              <input
                type="password"
                value={form.secret_key}
                onChange={(event) => onChange({ secret_key: event.target.value })}
                placeholder={editing ? "Leave blank to keep current key" : "sk-lf-..."}
                required={!editing}
              />
            </label>
          </div>

          <div className="form-error" role="alert">
            {error}
          </div>

          <div className="dialog-actions">
            <button className="command-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="command-button primary" type="submit">
              {editing ? "Save Changes" : "Add Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function agentInitials(agent) {
  const source = agent.display_name || agent.agent_id || "Agent";
  return source
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

const EMPTY_ORG_NODE_FORM = {
  node_name: "",
  node_code: "",
  parent_id: "",
  node_type_id: "",
  description: "",
  owner: "",
  sort_order: 0,
  status: "Active",
  effective_from: "",
  effective_to: "",
  tags: "",
};

const EMPTY_NODE_TYPE_FORM = {
  type_name: "",
  description: "",
  sort_order: 0,
  status: "Active",
};

function SettingsModule() {
  const [section, setSection] = useState("organization");
  const [nodes, setNodes] = useState([]);
  const [nodeTypes, setNodeTypes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [nodeQuery, setNodeQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [nodeDialog, setNodeDialog] = useState({ open: false, mode: "create", parentId: "", node: null });
  const [nodeForm, setNodeForm] = useState(EMPTY_ORG_NODE_FORM);
  const [moveDialog, setMoveDialog] = useState({ open: false, node: null, newParentId: "" });
  const [typeDialog, setTypeDialog] = useState({ open: false, mode: "create", type: null });
  const [typeForm, setTypeForm] = useState(EMPTY_NODE_TYPE_FORM);
  const [error, setError] = useState("");

  useEffect(() => {
    loadSettingsData();
  }, []);

  async function loadSettingsData() {
    try {
      const [hierarchy, types] = await Promise.all([fetchJson("/settings/organization-nodes/hierarchy"), fetchJson("/settings/node-types")]);
      setNodes(hierarchy);
      setNodeTypes(types);
      if (!selectedNodeId && hierarchy[0]) setSelectedNodeId(hierarchy[0].id);
      if (!expandedIds.size) setExpandedIds(new Set(hierarchy.map((node) => node.id)));
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  const flatNodes = useMemo(() => flattenOrgNodes(nodes), [nodes]);
  const selectedNode = flatNodes.find((node) => node.id === selectedNodeId) || null;
  const filteredNodes = useMemo(
    () => filterOrgTree(nodes, { query: nodeQuery, status: statusFilter, nodeTypeId: typeFilter }),
    [nodes, nodeQuery, statusFilter, typeFilter],
  );
  const breadcrumb = selectedNode ? selectedNode.path : [];

  function toggleNode(nodeId) {
    setExpandedIds((current) => {
      const next = new Set(current);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      return next;
    });
  }

  function openCreateNode(parentId = "") {
    setError("");
    setNodeForm({ ...EMPTY_ORG_NODE_FORM, parent_id: parentId, node_type_id: nodeTypes[0]?.id || "" });
    setNodeDialog({ open: true, mode: "create", parentId, node: null });
  }

  function openEditNode(node) {
    setError("");
    setNodeForm({
      node_name: node.node_name,
      node_code: node.node_code,
      parent_id: node.parent_id || "",
      node_type_id: node.node_type_id,
      description: node.description || "",
      owner: node.owner || "",
      sort_order: node.sort_order || 0,
      status: node.status || "Active",
      effective_from: node.effective_from || "",
      effective_to: node.effective_to || "",
      tags: (node.tags || []).join(", "),
    });
    setNodeDialog({ open: true, mode: "edit", parentId: node.parent_id || "", node });
  }

  async function saveNode(event) {
    event.preventDefault();
    setError("");
    const payload = normalizeNodePayload(nodeForm);
    if (!payload.node_name || !payload.node_code || !payload.node_type_id || !payload.status) {
      setError("Node Name, Node Code, Node Type, and Status are required.");
      return;
    }
    if (payload.effective_from && payload.effective_to && payload.effective_to < payload.effective_from) {
      setError("Effective To cannot be earlier than Effective From.");
      return;
    }
    try {
      const editing = nodeDialog.mode === "edit";
      const saved = await fetchJson(editing ? `/settings/organization-nodes/${nodeDialog.node.id}` : "/settings/organization-nodes", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedNodeId(saved.id);
      setNodeDialog({ open: false, mode: "create", parentId: "", node: null });
      await loadSettingsData();
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  async function archiveSelectedNode(node) {
    const hasChildren = node.children?.length > 0;
    const message = hasChildren
      ? `Archive ${node.node_name}? It has child nodes; they will remain in the hierarchy.`
      : `Archive ${node.node_name}?`;
    if (!window.confirm(message)) return;
    const archived = await fetchJson(`/settings/organization-nodes/${node.id}/archive`, { method: "POST" });
    setSelectedNodeId(archived.id);
    await loadSettingsData();
  }

  async function moveNode(event) {
    event.preventDefault();
    setError("");
    try {
      const moved = await fetchJson(`/settings/organization-nodes/${moveDialog.node.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_parent_id: moveDialog.newParentId || null }),
      });
      setSelectedNodeId(moved.id);
      setMoveDialog({ open: false, node: null, newParentId: "" });
      await loadSettingsData();
    } catch (moveError) {
      setError(moveError.message);
    }
  }

  async function adjustNodeOrder(node, direction) {
    const siblings = flatNodes.filter((item) => (item.parent_id || "") === (node.parent_id || "")).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const index = siblings.findIndex((item) => item.id === node.id);
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= siblings.length) return;
    const next = siblings.map((item, idx) => ({ id: item.id, sort_order: idx * 10 }));
    const currentOrder = next[index].sort_order;
    next[index].sort_order = next[swapIndex].sort_order;
    next[swapIndex].sort_order = currentOrder;
    await fetchJson("/settings/organization-nodes/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: node.parent_id || null, items: next }),
    });
    await loadSettingsData();
  }

  function openCreateType() {
    setError("");
    setTypeForm({ ...EMPTY_NODE_TYPE_FORM, sort_order: (nodeTypes.length + 1) * 10 });
    setTypeDialog({ open: true, mode: "create", type: null });
  }

  function openEditType(type) {
    setError("");
    setTypeForm({
      type_name: type.type_name,
      description: type.description || "",
      sort_order: type.sort_order || 0,
      status: type.status || "Active",
    });
    setTypeDialog({ open: true, mode: "edit", type });
  }

  async function saveType(event) {
    event.preventDefault();
    setError("");
    if (!typeForm.type_name.trim()) {
      setError("Node Type Name is required.");
      return;
    }
    try {
      const editing = typeDialog.mode === "edit";
      await fetchJson(editing ? `/settings/node-types/${typeDialog.type.id}` : "/settings/node-types", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...typeForm, type_name: typeForm.type_name.trim(), sort_order: Number(typeForm.sort_order || 0) }),
      });
      setTypeDialog({ open: false, mode: "create", type: null });
      await loadSettingsData();
    } catch (typeError) {
      setError(typeError.message);
    }
  }

  async function toggleType(type) {
    await fetchJson(`/settings/node-types/${type.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...type, status: type.status === "Active" ? "Inactive" : "Active" }),
    });
    await loadSettingsData();
  }

  async function adjustTypeOrder(type, direction) {
    const ordered = [...nodeTypes].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const index = ordered.findIndex((item) => item.id === type.id);
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= ordered.length) return;
    const payload = ordered.map((item, idx) => ({ id: item.id, sort_order: idx * 10 }));
    const currentOrder = payload[index].sort_order;
    payload[index].sort_order = payload[swapIndex].sort_order;
    payload[swapIndex].sort_order = currentOrder;
    await fetchJson("/settings/node-types/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadSettingsData();
  }

  return (
    <section className="settings-shell">
      <div className="settings-landing">
        <button className={`settings-section-card ${section === "organization" ? "active" : ""}`} type="button" onClick={() => setSection("organization")}>
          <span>Organization Structure</span>
          <strong>{flatNodes.length}</strong>
        </button>
        <button className={`settings-section-card ${section === "nodeTypes" ? "active" : ""}`} type="button" onClick={() => setSection("nodeTypes")}>
          <span>Node Types</span>
          <strong>{nodeTypes.length}</strong>
        </button>
      </div>

      {error && <div className="settings-error">{error}</div>}

      {section === "organization" ? (
        <div className="org-management">
          <div className="org-toolbar">
            <input value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} placeholder="Search name, code, owner, or type..." />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">All statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Archived">Archived</option>
            </select>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="">All node types</option>
              {nodeTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.type_name}
                </option>
              ))}
            </select>
            <button className="command-button primary" type="button" onClick={() => openCreateNode("")}>
              Add Root Node
            </button>
          </div>

          <div className="org-layout">
            <div className="org-tree-panel">
              {filteredNodes.length ? (
                filteredNodes.map((node) => (
                  <OrgTreeNode
                    key={node.id}
                    node={node}
                    selectedNodeId={selectedNodeId}
                    expandedIds={expandedIds}
                    onToggle={toggleNode}
                    onSelect={setSelectedNodeId}
                    onAddChild={openCreateNode}
                    onEdit={openEditNode}
                    onMove={(item) => setMoveDialog({ open: true, node: item, newParentId: item.parent_id || "" })}
                    onArchive={archiveSelectedNode}
                    onMoveOrder={adjustNodeOrder}
                  />
                ))
              ) : (
                <div className="empty-state">No organization nodes found.</div>
              )}
            </div>

            <aside className="org-detail-panel">
              {selectedNode ? (
                <>
                  <div className="org-breadcrumb">{breadcrumb.map((item) => item.node_name).join(" / ")}</div>
                  <div className="org-detail-header">
                    <div>
                      <h3>{selectedNode.node_name}</h3>
                      <code>{selectedNode.node_code}</code>
                    </div>
                    <span className={`org-status ${selectedNode.status.toLowerCase()}`}>{selectedNode.status}</span>
                  </div>
                  <dl className="org-detail-list">
                    <div><dt>Node Type</dt><dd>{selectedNode.node_type}</dd></div>
                    <div><dt>Level</dt><dd>{selectedNode.level}</dd></div>
                    <div><dt>Owner</dt><dd>{selectedNode.owner || "n/a"}</dd></div>
                    <div><dt>Sort Order</dt><dd>{selectedNode.sort_order}</dd></div>
                    <div><dt>Effective</dt><dd>{selectedNode.effective_from || "n/a"} to {selectedNode.effective_to || "n/a"}</dd></div>
                    <div><dt>Tags</dt><dd>{(selectedNode.tags || []).join(", ") || "n/a"}</dd></div>
                    <div><dt>Description</dt><dd>{selectedNode.description || "n/a"}</dd></div>
                  </dl>
                </>
              ) : (
                <div className="empty-state">Select a node to view its details.</div>
              )}
            </aside>
          </div>
        </div>
      ) : (
        <div className="node-type-management">
          <div className="node-type-header">
            <div>
              <h3>Node Type Management</h3>
              <p>Configure reusable hierarchy classification labels. Levels are calculated from parent-child relationships.</p>
            </div>
            <button className="command-button primary" type="button" onClick={openCreateType}>
              Add Node Type
            </button>
          </div>
          <div className="node-type-list">
            {nodeTypes.map((type) => (
              <article key={type.id} className="node-type-row">
                <div>
                  <strong>{type.type_name}</strong>
                  <span>{type.description || "No description"}</span>
                </div>
                <span className={`org-status ${type.status.toLowerCase()}`}>{type.status}</span>
                <code>{type.sort_order}</code>
                <div className="table-actions">
                  <button className="mini-button" type="button" onClick={() => adjustTypeOrder(type, -1)}>Up</button>
                  <button className="mini-button" type="button" onClick={() => adjustTypeOrder(type, 1)}>Down</button>
                  <button className="mini-button" type="button" onClick={() => openEditType(type)}>Edit</button>
                  <button className="mini-button" type="button" onClick={() => toggleType(type)}>{type.status === "Active" ? "Deactivate" : "Activate"}</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {nodeDialog.open && (
        <OrgNodeDialog
          mode={nodeDialog.mode}
          form={nodeForm}
          nodeTypes={nodeTypes}
          flatNodes={flatNodes}
          editingNodeId={nodeDialog.node?.id}
          onChange={(patch) => setNodeForm((current) => ({ ...current, ...patch }))}
          onSubmit={saveNode}
          onClose={() => setNodeDialog({ open: false, mode: "create", parentId: "", node: null })}
        />
      )}

      {moveDialog.open && (
        <MoveNodeDialog
          node={moveDialog.node}
          flatNodes={flatNodes}
          newParentId={moveDialog.newParentId}
          onChange={(newParentId) => setMoveDialog((current) => ({ ...current, newParentId }))}
          onSubmit={moveNode}
          onClose={() => setMoveDialog({ open: false, node: null, newParentId: "" })}
        />
      )}

      {typeDialog.open && (
        <NodeTypeDialog
          mode={typeDialog.mode}
          form={typeForm}
          onChange={(patch) => setTypeForm((current) => ({ ...current, ...patch }))}
          onSubmit={saveType}
          onClose={() => setTypeDialog({ open: false, mode: "create", type: null })}
        />
      )}
    </section>
  );
}

function OrgTreeNode({ node, selectedNodeId, expandedIds, onToggle, onSelect, onAddChild, onEdit, onMove, onArchive, onMoveOrder }) {
  const expanded = expandedIds.has(node.id);
  const hasChildren = node.children?.length > 0;
  const pathLabel = node.path?.map((item) => item.node_name).join(" / ") || node.node_name;
  return (
    <div className="org-tree-node">
      <div className={`org-tree-row ${selectedNodeId === node.id ? "active" : ""}`} style={{ paddingLeft: `${Math.max(0, node.level - 1) * 18 + 10}px` }}>
        <button className="tree-toggle" type="button" onClick={() => onToggle(node.id)} disabled={!hasChildren}>
          {hasChildren ? (expanded ? "-" : "+") : ""}
        </button>
        <button className="tree-main" type="button" onClick={() => onSelect(node.id)}>
          <strong>{node.node_name}</strong>
          <span>{node.node_code} / {node.node_type} / Level {node.level}</span>
          <small>{pathLabel}</small>
        </button>
        <div className="tree-actions">
          <button className="mini-button" type="button" onClick={() => onAddChild(node.id)}>Child</button>
          <button className="mini-button" type="button" onClick={() => onEdit(node)}>Edit</button>
          <button className="mini-button" type="button" onClick={() => onMove(node)}>Move</button>
          <button className="mini-button" type="button" onClick={() => onMoveOrder(node, -1)}>Up</button>
          <button className="mini-button" type="button" onClick={() => onMoveOrder(node, 1)}>Down</button>
          <button className="mini-button danger" type="button" onClick={() => onArchive(node)}>Archive</button>
        </div>
      </div>
      {expanded && hasChildren && node.children.map((child) => (
        <OrgTreeNode
          key={child.id}
          node={child}
          selectedNodeId={selectedNodeId}
          expandedIds={expandedIds}
          onToggle={onToggle}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onEdit={onEdit}
          onMove={onMove}
          onArchive={onArchive}
          onMoveOrder={onMoveOrder}
        />
      ))}
    </div>
  );
}

function OrgNodeDialog({ mode, form, nodeTypes, flatNodes, editingNodeId, onChange, onSubmit, onClose }) {
  const parentOptions = flatNodes.filter((node) => node.id !== editingNodeId && !isNodeDescendant(flatNodes, editingNodeId, node.id));
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="agent-dialog org-dialog" role="dialog" aria-modal="true">
        <form onSubmit={onSubmit}>
          <div className="dialog-header">
            <div>
              <h3>{mode === "edit" ? "Edit Organization Node" : "Create Organization Node"}</h3>
              <p>Maintain reusable organization structure master data.</p>
            </div>
            <button className="icon-button" type="button" onClick={onClose}>x</button>
          </div>
          <div className="dialog-grid">
            <label>Node Name<input value={form.node_name} onChange={(event) => onChange({ node_name: event.target.value })} required /></label>
            <label>Node Code<input value={form.node_code} onChange={(event) => onChange({ node_code: event.target.value })} required /></label>
          </div>
          <div className="dialog-grid">
            <label>
              Parent Node
              <select value={form.parent_id || ""} onChange={(event) => onChange({ parent_id: event.target.value })}>
                <option value="">Root node</option>
                {parentOptions.map((node) => <option key={node.id} value={node.id}>{node.path.map((item) => item.node_name).join(" / ")}</option>)}
              </select>
            </label>
            <label>
              Node Type
              <select value={form.node_type_id} onChange={(event) => onChange({ node_type_id: event.target.value })} required>
                <option value="">Select node type</option>
                {nodeTypes.filter((type) => type.status !== "Inactive").map((type) => <option key={type.id} value={type.id}>{type.type_name}</option>)}
              </select>
            </label>
          </div>
          <label>Description<textarea value={form.description} onChange={(event) => onChange({ description: event.target.value })} rows="3" /></label>
          <div className="dialog-grid">
            <label>Owner<input value={form.owner} onChange={(event) => onChange({ owner: event.target.value })} /></label>
            <label>Sort Order<input type="number" value={form.sort_order} onChange={(event) => onChange({ sort_order: event.target.value })} /></label>
          </div>
          <div className="dialog-grid">
            <label>Status<select value={form.status} onChange={(event) => onChange({ status: event.target.value })} required><option>Active</option><option>Inactive</option><option>Archived</option></select></label>
            <label>Tags<input value={form.tags} onChange={(event) => onChange({ tags: event.target.value })} placeholder="finance, budget, planning" /></label>
          </div>
          <div className="dialog-grid">
            <label>Effective From<input type="date" value={form.effective_from} onChange={(event) => onChange({ effective_from: event.target.value })} /></label>
            <label>Effective To<input type="date" value={form.effective_to} onChange={(event) => onChange({ effective_to: event.target.value })} /></label>
          </div>
          <div className="dialog-actions">
            <button className="command-button" type="button" onClick={onClose}>Cancel</button>
            <button className="command-button primary" type="submit">{mode === "edit" ? "Save Node" : "Create Node"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MoveNodeDialog({ node, flatNodes, newParentId, onChange, onSubmit, onClose }) {
  const parentOptions = flatNodes.filter((item) => item.id !== node?.id && !isNodeDescendant(flatNodes, node?.id, item.id));
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="agent-dialog" role="dialog" aria-modal="true">
        <form onSubmit={onSubmit}>
          <div className="dialog-header">
            <div><h3>Move Node</h3><p>Select a new parent. Circular moves are blocked.</p></div>
            <button className="icon-button" type="button" onClick={onClose}>x</button>
          </div>
          <label>
            New Parent Node
            <select value={newParentId || ""} onChange={(event) => onChange(event.target.value)}>
              <option value="">Root node</option>
              {parentOptions.map((item) => <option key={item.id} value={item.id}>{item.path.map((pathItem) => pathItem.node_name).join(" / ")}</option>)}
            </select>
          </label>
          <div className="dialog-actions">
            <button className="command-button" type="button" onClick={onClose}>Cancel</button>
            <button className="command-button primary" type="submit">Move Node</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NodeTypeDialog({ mode, form, onChange, onSubmit, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="agent-dialog" role="dialog" aria-modal="true">
        <form onSubmit={onSubmit}>
          <div className="dialog-header">
            <div><h3>{mode === "edit" ? "Edit Node Type" : "Add Node Type"}</h3><p>Configure hierarchy classification options.</p></div>
            <button className="icon-button" type="button" onClick={onClose}>x</button>
          </div>
          <label>Node Type Name<input value={form.type_name} onChange={(event) => onChange({ type_name: event.target.value })} required /></label>
          <label>Description<textarea value={form.description} onChange={(event) => onChange({ description: event.target.value })} rows="3" /></label>
          <div className="dialog-grid">
            <label>Sort Order<input type="number" value={form.sort_order} onChange={(event) => onChange({ sort_order: event.target.value })} /></label>
            <label>Status<select value={form.status} onChange={(event) => onChange({ status: event.target.value })}><option>Active</option><option>Inactive</option></select></label>
          </div>
          <div className="dialog-actions">
            <button className="command-button" type="button" onClick={onClose}>Cancel</button>
            <button className="command-button primary" type="submit">{mode === "edit" ? "Save Type" : "Add Type"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function flattenOrgNodes(nodes, path = []) {
  return nodes.flatMap((node) => {
    const currentPath = [...path, { id: node.id, node_name: node.node_name, node_code: node.node_code }];
    const current = { ...node, path: currentPath };
    return [current, ...flattenOrgNodes(node.children || [], currentPath)];
  });
}

function filterOrgTree(nodes, filters) {
  const query = filters.query.trim().toLowerCase();
  return nodes
    .map((node) => {
      const children = filterOrgTree(node.children || [], filters);
      const text = [node.node_name, node.node_code, node.owner, node.node_type].filter(Boolean).join(" ").toLowerCase();
      const matchesQuery = !query || text.includes(query);
      const matchesStatus = !filters.status || node.status === filters.status;
      const matchesType = !filters.nodeTypeId || node.node_type_id === filters.nodeTypeId;
      if ((matchesQuery && matchesStatus && matchesType) || children.length) return { ...node, children };
      return null;
    })
    .filter(Boolean);
}

function normalizeNodePayload(form) {
  return {
    node_name: form.node_name.trim(),
    node_code: form.node_code.trim(),
    parent_id: form.parent_id || null,
    node_type_id: form.node_type_id,
    description: form.description.trim() || null,
    owner: form.owner.trim() || null,
    sort_order: Number(form.sort_order || 0),
    status: form.status,
    effective_from: form.effective_from || null,
    effective_to: form.effective_to || null,
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
  };
}

function isNodeDescendant(flatNodes, ancestorId, candidateId) {
  if (!ancestorId || !candidateId) return false;
  const candidate = flatNodes.find((node) => node.id === candidateId);
  return candidate?.path?.some((item) => item.id === ancestorId) || false;
}

function AgentDetail({ selectedAgent, selectedRun, runs, events, onSelectRun }) {
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [collapsedIds, setCollapsedIds] = useState(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [durationFilter, setDurationFilter] = useState("");
  const [tokenFilter, setTokenFilter] = useState("");
  const [activeTab, setActiveTab] = useState("overview");

  const [runsSearch, setRunsSearch] = useState("");
  const [runsSort, setRunsSort] = useState({ field: "started_at", order: "desc" });
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  const traceTree = useMemo(() => buildTraceTree(events, selectedRun), [events, selectedRun]);
  const flattenedNodes = useMemo(() => flattenTraceNodes(traceTree), [traceTree]);
  const aggregateStats = useMemo(() => calculateAggregateStats(runs), [runs]);

  const filteredRuns = useMemo(() => {
    let result = runs.filter(
      (r) =>
        r.run_id.toLowerCase().includes(runsSearch.toLowerCase()) || (r.session_id && r.session_id.toLowerCase().includes(runsSearch.toLowerCase())),
    );

    result.sort((a, b) => {
      let valA = a[runsSort.field];
      let valB = b[runsSort.field];

      if (runsSort.field === "duration") {
        valA = new Date(a.last_event_at).getTime() - new Date(a.started_at).getTime();
        valB = new Date(b.last_event_at).getTime() - new Date(b.started_at).getTime();
      }

      if (valA < valB) return runsSort.order === "asc" ? -1 : 1;
      if (valA > valB) return runsSort.order === "asc" ? 1 : -1;
      return 0;
    });

    return result;
  }, [runs, runsSearch, runsSort]);

  const paginatedRuns = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRuns.slice(start, start + pageSize);
  }, [filteredRuns, currentPage]);

  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
  const visibleStart = filteredRuns.length ? (currentPage - 1) * pageSize + 1 : 0;
  const visibleEnd = Math.min(currentPage * pageSize, filteredRuns.length);

  useEffect(() => {
    setCurrentPage(1);
  }, [runsSearch]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    if (!selectedNodeId && flattenedNodes.length) {
      setSelectedNodeId(flattenedNodes[0].id);
    } else if (selectedNodeId && !flattenedNodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(flattenedNodes[0]?.id || "");
    }
  }, [flattenedNodes, selectedNodeId]);

  const selectedNode = flattenedNodes.find((node) => node.id === selectedNodeId) || flattenedNodes[0] || null;
  const filteredTree = useMemo(
    () => traceTree.map((node) => filterTraceTree(node, { categoryFilter, searchQuery, durationFilter, tokenFilter })).filter(Boolean),
    [traceTree, categoryFilter, searchQuery, durationFilter, tokenFilter],
  );
  const summary = useMemo(() => computeTraceSummary(selectedRun, events), [selectedRun, events]);
  const availableTabs = useMemo(() => (selectedNode ? traceTabsForNode(selectedNode) : []), [selectedNode]);

  useEffect(() => {
    if (selectedNode && availableTabs.length && !availableTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(availableTabs[0].id);
    }
  }, [selectedNode?.id, availableTabs, activeTab]);

  const toggleSort = (field) => {
    setRunsSort((current) => ({
      field,
      order: current.field === field && current.order === "desc" ? "asc" : "desc",
    }));
  };

  const getSortIcon = (field) => {
    if (runsSort.field !== field) return "";
    return runsSort.order === "asc" ? "^" : "v";
  };

  return (
    <div className="agent-detail-view">
      <section className="detail-topbar">
        <div>
          <span className="eyebrow">Agent Source</span>
          <div className="agent-title">
            <h2>{selectedAgent?.display_name || "Agent"}</h2>
            <code>{selectedAgent?.agent_id}</code>
          </div>
        </div>
        <div className="detail-status">
          <span className="status-pill">{selectedAgent?.provider} - {selectedAgent?.base_url}</span>
        </div>
      </section>

      <section className="aggregate-metrics-bar">
        <div className="metric-box">
          <span className="metric-label">Total Runs</span>
          <strong className="metric-value">{aggregateStats.total}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Success Rate</span>
          <strong className="metric-value">{aggregateStats.successRate.toFixed(1)}%</strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Avg Latency</span>
          <strong className="metric-value">{formatDuration(aggregateStats.avgLatency)}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Total Cost</span>
          <strong className="metric-value">{formatCost(aggregateStats.totalCost)}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Avg Cost/Run</span>
          <strong className="metric-value">{formatCost(aggregateStats.avgCost)}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Total Tokens</span>
          <strong className="metric-value">{Math.round(aggregateStats.totalTokens).toLocaleString()}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Avg Tokens/Run</span>
          <strong className="metric-value">{Math.round(aggregateStats.avgTokens).toLocaleString()}</strong>
        </div>
      </section>

      <section className="runs-explorer-section">
        <div className="section-header">
          <div className="section-title">
            <h3>Runs Explorer</h3>
            <span className="count-badge">{filteredRuns.length} total</span>
            <span className="range-badge">
              Showing {visibleStart}-{visibleEnd}
            </span>
          </div>
          <div className="explorer-actions">
              <input
                type="search"
                className="runs-search-input"
                placeholder="Filter by Run ID or Session..."
                value={runsSearch}
                onChange={(event) => setRunsSearch(event.target.value)}
              />
          </div>
        </div>

        <div className="table-container">
          <table className="runs-table">
        <thead>
          <tr>
                <th onClick={() => toggleSort("error_count")}>Status {getSortIcon("error_count")}</th>
                <th onClick={() => toggleSort("run_id")}>Run ID {getSortIcon("run_id")}</th>
                <th onClick={() => toggleSort("duration")}>Duration {getSortIcon("duration")}</th>
                <th onClick={() => toggleSort("total_tokens")}>Tokens {getSortIcon("total_tokens")}</th>
                <th onClick={() => toggleSort("total_cost")}>Cost {getSortIcon("total_cost")}</th>
                <th onClick={() => toggleSort("started_at")}>Started {getSortIcon("started_at")}</th>
                <th onClick={() => toggleSort("error_count")}>Errors {getSortIcon("error_count")}</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRuns.length ? paginatedRuns.map((run) => {
                const isSelected = run.run_id === selectedRun?.run_id;
                const start = new Date(run.started_at).getTime();
                const end = new Date(run.last_event_at).getTime();
                const duration = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
                return (
                  <tr key={run.run_id} className={isSelected ? "active" : ""} onClick={() => onSelectRun(run)}>
                    <td>
                      <span className={`status-tag ${run.error_count > 0 ? "failed" : "success"}`}>
                        {run.error_count > 0 ? "Failed" : "Success"}
                      </span>
                    </td>
                    <td>
                      <code>{shortId(run.run_id)}</code>
                    </td>
                    <td>{formatDuration(duration)}</td>
                    <td>{(run.total_tokens || 0).toLocaleString()}</td>
                    <td>{formatCost(run.total_cost)}</td>
                    <td>{formatDate(run.started_at)}</td>
                    <td>{run.error_count || 0}</td>
                  </tr>
  );
              }) : (
                <tr>
                  <td colSpan="7" className="empty-table-cell">
                    <div className="empty-state">No runs found matching your criteria.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination">
          <button disabled={currentPage === 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
            Previous
          </button>
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <button disabled={currentPage === totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>
            Next
          </button>
        </div>
      </section>

      {selectedRun && (
        <div className="trace-explorer-container">
          <section className="trace-summary-panel">
            <SummaryCard
              label="Status"
              value={summary.status}
              variant={summary.status === "Error" ? "danger" : summary.status === "Running" ? "warn" : "success"}
            />
            <SummaryCard label="Duration" value={formatDuration(summary.duration)} />
            <SummaryCard label="Tokens" value={summary.totalTokens.toLocaleString()} />
            <SummaryCard label="Cost" value={formatCost(summary.totalCost)} />
            <SummaryCard label="LLM Calls" value={summary.llmCalls} />
            <SummaryCard label="Tool Calls" value={summary.toolCalls} />
            <SummaryCard label="Errors" value={summary.errorCount} />
          </section>

          <section className="trace-detail-layout">
            <aside className="trace-sidebar">
              <div className="trace-filter-panel compact">
                <div className="trace-filter-row">
                  <input
                    type="search"
                    value={searchQuery}
                    placeholder="Search spans, types, metadata..."
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
                <div className="trace-filter-chips" role="group">
                  {TRACE_FILTERS.map((filterItem) => (
                    <button
                      key={filterItem.id}
                      type="button"
                      className={`filter-chip ${categoryFilter === filterItem.id ? "active" : ""}`}
                      onClick={() => setCategoryFilter(filterItem.id)}
                    >
                      {filterItem.label}
                    </button>
                  ))}
                </div>
                <div className="trace-range-filters">
                  <label>
                    Min duration
                    <input
                      type="number"
                      min="0"
                      value={durationFilter}
                      onChange={(event) => setDurationFilter(event.target.value)}
                      placeholder="0"
                    />
                  </label>
                  <label>
                    Min tokens
                    <input
                      type="number"
                      min="0"
                      value={tokenFilter}
                      onChange={(event) => setTokenFilter(event.target.value)}
                      placeholder="0"
                    />
                  </label>
                </div>
              </div>
            </aside>

            <main className="trace-main">
              <div className="trace-tree-shell expanded">
                {filteredTree.length ? (
                  <div className="trace-tree">
                    {filteredTree.map((node) => (
                      <TraceNodeRow
                        key={node.id}
                        node={node}
                        depth={0}
                        selectedNodeId={selectedNodeId}
                        onSelectNode={setSelectedNodeId}
                        collapsedIds={collapsedIds}
                        onToggleCollapse={(id) => {
                          setCollapsedIds((current) => {
                            const next = new Set(current);
                            next.has(id) ? next.delete(id) : next.add(id);
                            return next;
                          });
                        }}
                        runStart={summary.startedAt}
                        totalDuration={summary.duration}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">No trace events match the current filters.</div>
                )}
              </div>
            </main>

            <aside className="detail-panel secondary">
              <div className="detail-panel-header">
                <div>
                  <span className="eyebrow">Detail panel</span>
                  <h3>{selectedNode ? selectedNode.label : "Select a span to inspect"}</h3>
                </div>
              </div>
              <div className="detail-panel-body">
                {selectedNode ? (
                  <TraceDetailPanel node={selectedNode} activeTab={activeTab} onSelectTab={setActiveTab} />
                ) : (
                  <div className="empty-state">Click any trace span to inspect timing, I/O, and errors.</div>
                )}
              </div>
            </aside>
          </section>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, variant = "surface" }) {
  return (
    <div className={`summary-card ${variant}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TraceNodeRow({ node, depth, selectedNodeId, onSelectNode, collapsedIds, onToggleCollapse, runStart, totalDuration }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedIds.has(node.id);
  const isSelected = selectedNodeId === node.id;
  const offset = totalDuration ? ((node.startTime.getTime() - new Date(runStart).getTime()) / totalDuration) * 100 : 0;
  const width = totalDuration ? Math.max(1, Math.min(100, (node.duration / totalDuration) * 100)) : 0;
  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectNode(node.id);
    }
  };

  return (
    <div className={`trace-node-group ${depth > 0 ? "nested" : ""}`} style={{ marginLeft: depth * 18 }}>
      <div
        role="button"
        tabIndex={0}
        className={`trace-node ${isSelected ? "selected" : ""} ${node.status}`}
        onClick={() => onSelectNode(node.id)}
        onKeyDown={handleKeyDown}
      >
        <div className="trace-node-badge">
          {hasChildren ? (
            <button
              type="button"
              className="toggle-button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleCollapse(node.id);
              }}
              aria-label={isCollapsed ? "Expand span" : "Collapse span"}
            >
              {isCollapsed ? "+" : "-"}
            </button>
          ) : (
            <span className="toggle-spacer" />
          )}
          <span className={`trace-icon ${node.category}`}>{eventIcon(node.category)}</span>
        </div>
        <div className="trace-node-content">
          <div className="trace-node-title">{node.label}</div>
          <div className="trace-node-meta">
            <span>{node.model || node.type}</span>
            <span>{node.preview || node.stepName || "No preview available"}</span>
          </div>
          <div className="trace-node-timing">
            <div className="trace-bar-track">
              <div className="trace-bar-fill" style={{ width: `${width}%`, marginLeft: `${offset}%` }} />
            </div>
          </div>
        </div>
        <div className="trace-node-summary">
          <span className={`status-chip ${node.status}`}>{node.status === "error" ? "Error" : node.status === "running" ? "Running" : "Success"}</span>
          <span>{formatDuration(node.duration)}</span>
          <span>{node.tokens ? `${node.tokens} tok` : "-"}</span>
          <span>{node.cost ? formatCost(node.cost) : "-"}</span>
        </div>
      </div>
      {!isCollapsed && node.children.map((child) => (
        <TraceNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          collapsedIds={collapsedIds}
          onToggleCollapse={onToggleCollapse}
          runStart={runStart}
          totalDuration={totalDuration}
        />
      ))}
    </div>
  );
}

function TraceDetailPanel({ node, activeTab, onSelectTab }) {
  const rawEvent = node.event;
  const inputContent = parseJsonValue(rawEvent.input_payload ?? rawEvent.input_preview);
  const outputContent = parseJsonValue(rawEvent.output_payload ?? rawEvent.output_preview);
  const metadataContent = normalizePayload(rawEvent.metadata || {});
  const tabs = traceTabsForNode(node);

  return (
    <div className="detail-panel-content">
      <div className="detail-tab-list detail-tab-list--sticky">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`detail-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "overview" && <OverviewTab node={node} />}
      {activeTab === "prompt" && <JsonSection title="Prompt" data={parseJsonValue(rawEvent.input_payload ?? rawEvent.input_preview)} />}
      {activeTab === "completion" && <JsonSection title="Completion" data={parseJsonValue(rawEvent.output_payload ?? rawEvent.output_preview)} />}
      {activeTab === "input" && <JsonSection title="Input" data={inputContent} />}
      {activeTab === "output" && <JsonSection title="Output" data={outputContent} />}
      {activeTab === "usage" && <UsageTab node={node} />}
      {activeTab === "metadata" && <MetadataTab data={metadataContent} />}
      {activeTab === "error" && <ErrorTab node={node} />}
      {activeTab === "raw" && <JsonSection title="Raw JSON" data={rawEvent} raw />}
    </div>
  );
}

function traceTabsForNode(node) {
  const base = [{ id: "overview", label: "Overview" }];
  if (node.category === "llm") {
    return [...base, { id: "prompt", label: "Prompt" }, { id: "completion", label: "Completion" }, { id: "usage", label: "Usage" }, { id: "raw", label: "Raw JSON" }];
  }
  if (node.category === "tools") {
    return [...base, { id: "input", label: "Input" }, { id: "output", label: "Output" }, { id: "metadata", label: "Metadata" }, { id: "raw", label: "Raw JSON" }];
  }
  if (node.category === "user_input") {
    return [...base, { id: "input", label: "Input" }, { id: "raw", label: "Raw JSON" }];
  }
  if (node.category === "output") {
    return [...base, { id: "output", label: "Output" }, { id: "metadata", label: "Metadata" }, { id: "raw", label: "Raw JSON" }];
  }
  if (node.category === "errors") {
    return [...base, { id: "error", label: "Error Details" }, { id: "raw", label: "Raw JSON" }];
  }
  return [...base, { id: "metadata", label: "Metadata" }, { id: "raw", label: "Raw JSON" }];
}

function ErrorTab({ node }) {
  const rawEvent = node.event;
  return (
    <section className="detail-section">
      <h4>Error details</h4>
      <div className="detail-summary">
        <strong>{rawEvent.error || rawEvent.event_type}</strong>
        <div className="detail-badges">
          {rawEvent.error_type && <span>{rawEvent.error_type}</span>}
          {rawEvent.error_code && <span>{rawEvent.error_code}</span>}
        </div>
        <div className="payload-block">{rawEvent.error_message || JSON.stringify(rawEvent, null, 2)}</div>
      </div>
    </section>
  );
}

function OverviewTab({ node }) {
  return (
    <div className="overview-grid">
      <KeyValues
        title="Overview"
        rows={[
          ["Event ID", node.id],
          ["Run ID", node.runId],
          ["Parent", node.parentLabel || "root"],
          ["Agent", node.agentId],
          ["Step", node.stepName],
          ["Event Type", node.type],
          ["Status", node.status],
          ["Started At", formatDate(node.startTime)],
          ["Ended At", node.endTime ? formatDate(node.endTime) : "In progress"],
          ["Duration", formatDuration(node.duration)],
        ]}
      />
    </div>
  );
}

function JsonSection({ title, data, raw = false }) {
  const [copied, setCopied] = useState(false);
  const value = raw ? data : data;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="json-section">
      <div className="json-section-header">
        <h4>{title}</h4>
        <button type="button" className="mini-button" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="json-frame">
        {data === null || data === undefined || data === "" ? (
          <div className="empty-state">No payload available.</div>
        ) : (
          <JsonInspector data={data} />
        )}
      </div>
    </section>
  );
}

function JsonInspector({ data }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const toggle = (path) => {
    setCollapsed((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  return <div className="json-inspector">{renderJsonValue(data, "root", collapsed, toggle)}</div>;
}

function renderJsonValue(value, path, collapsed, toggle) {
  if (Array.isArray(value)) {
    const isClosed = collapsed.has(path);
    return (
      <div className="json-node">
        <button type="button" className="json-toggle" onClick={() => toggle(path)}>
          {isClosed ? "+" : "-"}
        </button>
        <span className="json-type">Array[{value.length}]</span>
        {!isClosed && (
          <div className="json-children">
            {value.map((item, index) => renderJsonValue(item, `${path}.${index}`, collapsed, toggle))}
          </div>
        )}
      </div>
    );
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const isClosed = collapsed.has(path);
    return (
      <div className="json-node">
        <button type="button" className="json-toggle" onClick={() => toggle(path)}>
          {isClosed ? "+" : "-"}
        </button>
        <span className="json-type">Object{entries.length ? "" : " { }"}</span>
        {!isClosed && entries.length > 0 && (
          <div className="json-children">
            {entries.map(([key, child]) => (
              <div key={key} className="json-entry">
                <span className="json-key">{key}:</span>
                {renderJsonValue(child, `${path}.${key}`, collapsed, toggle)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === "string") {
    return <pre className="json-primitive json-string">{value}</pre>;
  }

  return <span className={`json-primitive json-${typeof value}`}>{String(value)}</span>;
}

function UsageTab({ node }) {
  return (
    <section className="detail-section usage-grid">
      <KeyValues
        title="Usage"
        rows={[
          ["Prompt Tokens", node.promptTokens || 0],
          ["Completion Tokens", node.completionTokens || 0],
          ["Total Tokens", node.tokens || 0],
          ["Prompt Cost", formatCost(node.promptCost)],
          ["Completion Cost", formatCost(node.completionCost)],
          ["Total Cost", formatCost(node.cost)],
          ["Model", node.model || "n/a"],
          ["Provider", node.provider || "n/a"],
          ["Temperature", node.temperature ?? "n/a"],
          ["Max Tokens", node.maxTokens ?? "n/a"],
        ]}
      />
    </section>
  );
}

function MetadataTab({ data }) {
  const rows = Array.isArray(data) ? [] : flattenPayload(data);
  if (!rows.length) return <div className="empty-state">No metadata available.</div>;
  return (
    <section className="detail-section">
      <h4>Metadata</h4>
      <table className="metadata-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path}>
              <td>{row.path}</td>
              <td>{formatPayloadValue(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function flattenTraceNodes(nodes, parent = null) {
  return nodes.flatMap((node) => [node, ...flattenTraceNodes(node.children, node)]);
}

function buildTraceTree(events, selectedRun) {
  if (!events?.length) return [];

  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const runStartEvent = sorted.find((event) => event.event_type === "run_start");
  const runEndEvent = [...sorted].reverse().find((event) => event.event_type === "run_end" || event.event_type === "run_error");

  const startTime = runStartEvent ? new Date(runStartEvent.timestamp) : new Date(sorted[0].timestamp);
  const endTime = runEndEvent ? new Date(runEndEvent.timestamp) : new Date(sorted[sorted.length - 1].timestamp);
  const duration = Math.max(0, endTime.getTime() - startTime.getTime());
  const root = {
    id: `run-${selectedRun?.run_id || "root"}`,
    runId: selectedRun?.run_id || "",
    agentId: selectedRun?.agent_id || events[0]?.agent_id || "",
    label: `Run ${shortId(selectedRun?.run_id || "root")}`,
    stepName: selectedRun?.run_id || "Run trace",
    type: "run",
    category: "workflow",
    status: events.some((event) => event.error || event.event_type.includes("error")) ? "error" : runEndEvent ? "success" : "running",
    startTime,
    endTime: endTime,
    duration,
    tokens: Number(selectedRun?.total_tokens || events.reduce((sum, event) => sum + Number(event.token_usage?.total || event.total_tokens || 0), 0)),
    cost: Number(selectedRun?.total_cost || 0),
    model: selectedRun?.agent_id || "",
    provider: selectedRun?.agent_id || "",
    preview: selectedRun?.run_id || "",
    parentId: null,
    parentLabel: null,
    children: [],
    event: runStartEvent || sorted[0],
  };

  const stack = [root];
  const matchingStart = {
    run_end: "run_start",
    run_error: "run_start",
    step_end: "step_start",
    tool_call_end: "tool_call_start",
    tool_call_error: "tool_call_start",
    llm_call_end: "llm_call_start",
  };

  for (const event of sorted) {
    const type = event.event_type;
    if (type === "run_start") {
      continue;
    }

    const isStart = type === "step_start" || type === "tool_call_start" || type === "llm_call_start";
    const isEnd = Object.prototype.hasOwnProperty.call(matchingStart, type);

    if (isStart) {
      const node = createTraceNode(event, stack[stack.length - 1]);
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }

    if (isEnd) {
      const startType = matchingStart[type];
      let matchedIndex = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].type === startType) {
          matchedIndex = i;
          break;
        }
      }
      if (matchedIndex >= 0) {
        const matched = stack[matchedIndex];
        matched.endTime = new Date(event.timestamp);
        matched.duration = Number.isFinite(Number(event.latency_ms)) ? event.latency_ms : Math.max(0, matched.endTime.getTime() - matched.startTime.getTime());
        matched.status = event.error ? "error" : matched.status;
        matched.outputPreview = event.output_preview || matched.outputPreview;
        matched.output_payload = event.output_payload ?? matched.output_payload;
        matched.error = event.error ?? matched.error;
        matched.metadata = { ...matched.metadata, ...(event.metadata || {}) };
        stack.splice(matchedIndex);
        continue;
      }
    }

    const node = createTraceNode(event, stack[stack.length - 1]);
    stack[stack.length - 1].children.push(node);
  }

  return [root];
}

function createTraceNode(event, parent) {
  const startTime = new Date(event.timestamp);
  const duration = Number.isFinite(Number(event.latency_ms)) ? event.latency_ms : 0;
  const category = eventCategory(event);
  const preview = event.output_preview || event.input_preview || event.step_name || event.tool_name || "";
  const model = event.metadata?.model || event.metadata?.provider || "";
  const promptTokens = Number(event.metadata?.prompt_tokens || event.prompt_tokens || event.token_usage?.prompt || 0);
  const completionTokens = Number(event.metadata?.completion_tokens || event.token_usage?.completion || 0);
  const totalTokens = Number(event.total_tokens || event.token_usage?.total || promptTokens + completionTokens || 0);
  const cost = Number(event.metadata?.total_cost || 0);
  const provider = event.metadata?.provider || "";

  return {
    id: event.event_id,
    runId: event.run_id,
    agentId: event.agent_id,
    label: event.step_name || event.tool_name || normalizeEventLabel(event.event_type),
    stepName: event.step_name || event.tool_name || "",
    type: event.event_type,
    category,
    status: event.error || event.event_type.includes("error") ? "error" : duration ? "success" : "running",
    startTime,
    endTime: duration ? new Date(startTime.getTime() + duration) : null,
    duration,
    tokens: totalTokens,
    promptTokens,
    completionTokens,
    promptCost: Number(event.metadata?.prompt_cost || 0),
    completionCost: Number(event.metadata?.completion_cost || 0),
    cost,
    model,
    provider,
    preview,
    parentId: parent?.id || null,
    parentLabel: parent?.label || null,
    children: [],
    event,
    metadata: event.metadata || {},
    input_payload: event.input_payload,
    output_payload: event.output_payload,
  };
}

function normalizeEventLabel(type) {
  return EVENT_LABELS[type] || type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function eventCategory(event) {
  if (event.event_type.includes("error")) return "errors";
  if (event.event_type.startsWith("llm")) return "llm";
  if (event.event_type.startsWith("tool")) return "tools";
  if (event.event_type === "run_start" || event.event_type === "step_start" || event.event_type === "step_end") {
    const name = `${event.step_name || ""}`.toLowerCase();
    if (name.includes("input")) return "user_input";
    if (name.includes("output")) return "output";
    return "workflow";
  }
  if (event.output_preview || event.output_payload) return "output";
  return "workflow";
}

function eventIcon(category) {
  if (category === "user_input") return "IN";
  if (category === "workflow") return "WF";
  if (category === "llm") return "AI";
  if (category === "output") return "OUT";
  if (category === "tools") return "TL";
  if (category === "errors") return "ER";
  return "--";
}

function filterTraceTree(node, filters) {
  const match = nodeMatchesFilters(node, filters);
  const children = node.children.map((child) => filterTraceTree(child, filters)).filter(Boolean);
  if (match || children.length) {
    return { ...node, children };
  }
  return null;
}

function nodeMatchesFilters(node, filters) {
  if (filters.categoryFilter && filters.categoryFilter !== "all" && node.category !== filters.categoryFilter) {
    return false;
  }

  if (filters.searchQuery) {
    const text = [node.label, node.type, node.model, node.provider, node.preview, node.stepName, JSON.stringify(node.metadata)].join(" ").toLowerCase();
    if (!text.includes(filters.searchQuery.toLowerCase())) {
      return false;
    }
  }

  const minDuration = Number(filters.durationFilter);
  if (filters.durationFilter && Number.isFinite(minDuration) && (node.duration || 0) < minDuration) {
    return false;
  }

  const minTokens = Number(filters.tokenFilter);
  if (filters.tokenFilter && Number.isFinite(minTokens) && (node.tokens || 0) < minTokens) {
    return false;
  }

  return true;
}

function computeTraceSummary(selectedRun, events) {
  const runStart = events.find((event) => event.event_type === "run_start");
  const runEnd = [...events].reverse().find((event) => event.event_type === "run_end" || event.event_type === "run_error");
  const startedAt = runStart?.timestamp || selectedRun?.started_at || null;
  const completedAt = runEnd?.timestamp || selectedRun?.last_event_at || null;
  const duration = startedAt && completedAt ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()) : 0;
  const llmCalls = events.filter((event) => event.event_type.startsWith("llm")).length;
  const toolCalls = events.filter((event) => event.event_type.startsWith("tool")).length;
  const errorCount = events.filter((event) => event.error || event.event_type.includes("error")).length;
  const totalTokens = Number(selectedRun?.total_tokens || events.reduce((sum, event) => sum + Number(event.token_usage?.total || event.total_tokens || 0), 0));
  const totalCost = Number(selectedRun?.total_cost || 0);
  return {
    status: errorCount ? "Error" : runEnd ? "Completed" : "Running",
    duration,
    totalTokens,
    totalCost,
    llmCalls,
    toolCalls,
    errorCount,
    startedAt,
    completedAt,
  };
}

function extractMetadataRows(data) {
  if (!data || typeof data !== "object") return [];
  return flattenPayload(data);
}
function parseJsonValue(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function KeyValues({ title, rows }) {
  const filtered = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!filtered.length) return null;
  return (
    <section className="detail-section detail-overview">
      <h4>{title}</h4>
      <dl className="kv-list">
        {filtered.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{String(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

function filterRuns(runs, filter) {
  const query = filter.trim().toLowerCase();
  if (!query) return runs;
  return runs.filter((run) => `${run.run_id} ${run.agent_id} ${run.session_id || ""}`.toLowerCase().includes(query));
}

function dedupeEvents(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = eventFingerprint(event);
    const existing = byKey.get(key);
    if (!existing || eventScore(event) > eventScore(existing)) byKey.set(key, event);
  }
  return Array.from(byKey.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function eventFingerprint(event) {
  const metadata = event.metadata || {};
  const observationId = metadata.observation_id || metadata.trace_id || event.run_id;
  return `${event.agent_id}:${event.run_id}:${observationId}:${event.event_type}:${event.step_name || ""}:${event.tool_name || ""}`;
}

function eventScore(event) {
  let score = 0;
  if (event.event_id?.includes(`:${event.agent_id}:`)) score += 10;
  if (event.input_payload) score += 3;
  if (event.output_payload) score += 3;
  if (event.input_preview) score += 1;
  if (event.output_preview) score += 1;
  return score;
}

function selectedRunMetrics(selectedRun, events, breakdown) {
  const startedAt = new Date(selectedRun?.started_at).getTime();
  const endedAt = new Date(selectedRun?.last_event_at).getTime();
  return {
    events: events.length || Number(selectedRun?.event_count || 0),
    errors: events.filter((event) => event.event_type.includes("error")).length || Number(selectedRun?.error_count || 0),
    tokens: events.reduce((sum, event) => sum + Number(event.total_tokens || event.token_usage?.total || 0), 0) || Number(selectedRun?.total_tokens || 0),
    cost: breakdown.total || Number(selectedRun?.total_cost || 0),
    duration: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : 0,
  };
}

function calculateAggregateStats(runs) {
  const total = runs.length;
  if (!total) {
    return { total: 0, successRate: 0, avgLatency: 0, totalCost: 0, avgCost: 0, totalTokens: 0, avgTokens: 0 };
  }

  const totals = runs.reduce(
    (acc, run) => {
      const startedAt = new Date(run.started_at).getTime();
      const endedAt = new Date(run.last_event_at).getTime();
      const duration = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : 0;
      return {
        success: acc.success + (Number(run.error_count || 0) > 0 ? 0 : 1),
        latency: acc.latency + duration,
        cost: acc.cost + Number(run.total_cost || 0),
        tokens: acc.tokens + Number(run.total_tokens || 0),
      };
    },
    { success: 0, latency: 0, cost: 0, tokens: 0 },
  );

  return {
    total,
    successRate: (totals.success / total) * 100,
    avgLatency: totals.latency / total,
    totalCost: totals.cost,
    avgCost: totals.cost / total,
    totalTokens: totals.tokens,
    avgTokens: totals.tokens / total,
  };
}

function emptyCostBreakdown() {
  return { input: 0, output: 0, other: 0, total: 0 };
}

function calculateCostBreakdown(events) {
  const breakdown = emptyCostBreakdown();
  const seen = new Set();
  for (const event of events) {
    if (event.event_type !== "llm_call_end") continue;
    const observationId = event.metadata?.observation_id || event.event_id;
    if (seen.has(observationId)) continue;
    seen.add(observationId);
    const totalCost = eventCost(event);
    const promptTokens = Number(event.prompt_tokens || event.token_usage?.prompt || 0);
    const completionTokens = Number(event.completion_tokens || event.token_usage?.completion || 0);
    const totalTokens = Number(event.total_tokens || event.token_usage?.total || promptTokens + completionTokens || 0);
    if (totalCost > 0 && totalTokens > 0) {
      breakdown.input += totalCost * (promptTokens / totalTokens);
      breakdown.output += totalCost * (completionTokens / totalTokens);
      breakdown.other += totalCost * Math.max(0, (totalTokens - promptTokens - completionTokens) / totalTokens);
    } else {
      breakdown.other += totalCost;
    }
  }
  breakdown.total = breakdown.input + breakdown.output + breakdown.other;
  return breakdown;
}

function eventCost(event) {
  if (event.event_type !== "llm_call_end") return 0;
  const cost = Number(event.metadata?.total_cost || 0);
  return Number.isFinite(cost) ? cost : 0;
}

function viewCost(viewId, breakdown) {
  if (viewId === "all" || viewId === "llm") return breakdown.total;
  if (viewId === "user_input") return breakdown.input;
  if (viewId === "output") return breakdown.output;
  return 0;
}

function eventMatchesView(event, viewId) {
  const name = `${event.step_name || ""} ${event.tool_name || ""}`.toLowerCase();
  const type = event.event_type.toLowerCase();
  if (viewId === "transactions") return false;
  if (viewId === "all") return true;
  if (viewId === "workflow") return name.includes("workflow") || type === "run_start" || type === "run_end";
  if (viewId === "user_input") return name.includes("user input") || name.includes("input");
  if (viewId === "llm") return type.startsWith("llm_") || name === "llm";
  if (viewId === "output") return name.includes("output");
  if (viewId === "tools") return type.startsWith("tool_") || Boolean(event.tool_name);
  if (viewId === "errors") return type.includes("error") || Boolean(event.error);
  return true;
}

function typeClass(type) {
  if (type.includes("error")) return "error";
  if (type.includes("drift") || type.includes("loop") || type.includes("handoff")) return "warn";
  return "";
}

function normalizePayload(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function flattenPayload(value, prefix = "", rows = []) {
  if (Array.isArray(value)) {
    if (!value.length) {
      rows.push({ path: prefix || "value", value: "empty list" });
      return rows;
    }
    if (prefix) rows.push({ path: prefix, value: `${value.length} items` });
    value.forEach((item, index) => flattenPayload(item, prefix ? `${prefix}.${index}` : String(index), rows));
    return rows;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) {
      rows.push({ path: prefix || "value", value: "empty object" });
      return rows;
    }
    for (const [key, child] of entries) flattenPayload(child, prefix ? `${prefix}.${key}` : key, rows);
    return rows;
  }
  rows.push({ path: prefix || "value", value });
  return rows;
}

createRoot(document.getElementById("root")).render(<App />);

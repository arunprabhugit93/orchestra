import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { auditClientEvent, clearAuth, fetchJson, getStoredAuth, storeAuth } from "./api/client";
import { DATA_VIEWS, EMPTY_AGENT_FORM, EVENT_LABELS, TRACE_FILTERS } from "./domain/constants";
import { AiAgentOnboardingModule } from "./aiIntakeModule.jsx";
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

const AI_INTAKE_SECTIONS = [
  { id: "new", label: "New Request" },
  { id: "requests", label: "Requests" },
  { id: "qualification", label: "Qualification Queue" },
  { id: "detail", label: "Request Detail / Impact View" },
  { id: "departments", label: "Departments" },
  { id: "systems", label: "Systems" },
  { id: "touchpoints", label: "Integration Touchpoints" },
  { id: "dataDomains", label: "Data Domains" },
  { id: "userGroups", label: "User Groups" },
  { id: "processAreas", label: "Process Areas" },
];

function App() {
  const [auth, setAuth] = useState(() => getStoredAuth());
  const [authChecking, setAuthChecking] = useState(Boolean(getStoredAuth()?.token));
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
  const [agentOrgNodes, setAgentOrgNodes] = useState([]);
  const [formError, setFormError] = useState("");
  const [agentSubmitting, setAgentSubmitting] = useState(false);
  const [pageError, setPageError] = useState("");
  const [graphSection, setGraphSection] = useState("overview");
  const [intakeSection, setIntakeSection] = useState("new");
  const [selectedIntakeId, setSelectedIntakeId] = useState("");

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
    function handleExpired() {
      setAuth(null);
      setConnectionStatus("Login required");
    }
    window.addEventListener("agent-monitor-auth-expired", handleExpired);
    return () => window.removeEventListener("agent-monitor-auth-expired", handleExpired);
  }, []);

  useEffect(() => {
    if (!auth?.token) return;
    const checkingTimer = window.setTimeout(() => setAuthChecking(false), 5000);
    let active = true;
    setAuthChecking(true);
    fetchJson("/auth/me")
      .then((session) => {
        if (!active) return;
        const nextAuth = { ...auth, email: session.email, expires_at: session.expires_at };
        storeAuth(nextAuth);
        setAuth(nextAuth);
        setConnectionStatus("Connecting");
        loadAgents();
      })
      .catch(() => {
        if (!active) return;
        handleLogout();
      })
      .finally(() => {
        if (active) setAuthChecking(false);
      });
    return () => {
      active = false;
      window.clearTimeout(checkingTimer);
    };
  }, [auth?.token]);

  useEffect(() => {
    if (!auth?.token) return;
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
  }, [auth?.token, selectedRunId, selectedRunAgentId]);

  function handleLogin(nextAuth) {
    storeAuth(nextAuth);
    setAuth(nextAuth);
  }

  function handleLogout() {
    clearAuth();
    setAuth(null);
    setAgents([]);
    setRuns([]);
    setEvents([]);
    setSelectedAgentId("");
    setConnectionStatus("Login required");
  }

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

  function openOrganizationGraph() {
    setMode("organization_graph");
  }

  function openAiIntake(section = "new") {
    auditClientEvent({ eventType: "frontend_navigation", status: "success", module: "frontend/App", function: "openAiIntake", message: `Open AI intake ${section}` });
    setMode("ai_intake");
    setIntakeSection(section);
  }

  function openAudit() {
    auditClientEvent({ eventType: "frontend_navigation", status: "success", module: "frontend/App", function: "openAudit", message: "Open audit module" });
    setMode("audit");
  }

  async function importLangfuse() {
    if (!selectedAgentId) return;
    try {
      setConnectionStatus("Importing");
      const result = await fetchJson(`/agents/${encodeURIComponent(selectedAgentId)}/import-langfuse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100, max_pages: 2 }),
      });
      if (result?.error) throw new Error(result.error);
      await loadRuns(selectedAgentId, { keepTransactionsView: true });
      setConnectionStatus("Live");
    } catch (error) {
      setConnectionStatus("Import failed");
      window.alert(`Langfuse import failed: ${error.message}`);
    }
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

  async function loadAgentOrgNodes() {
    try {
      const hierarchy = await fetchJson("/settings/organization-nodes/hierarchy");
      setAgentOrgNodes(flattenOrgNodes(hierarchy).filter((node) => node.status !== "Archived"));
    } catch {
      setAgentOrgNodes([]);
    }
  }

  async function openCreateDialog() {
    setFormError("");
    setAgentSubmitting(false);
    setAgentForm(EMPTY_AGENT_FORM);
    await loadAgentOrgNodes();
    setAgentDialog({ open: true, mode: "create", agent: null });
  }

  async function openEditDialog(agent) {
    setFormError("");
    setAgentSubmitting(false);
    const profile = agent.profile || {};
    const mappings = agent.node_mappings || [];
    const primary = mappings.find((mapping) => mapping.placement_type === "Primary");
    setAgentForm({
      ...EMPTY_AGENT_FORM,
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      base_url: agent.base_url,
      public_key: "",
      secret_key: "",
      ...profile,
      primary_node_id: primary?.node_id || "",
      supporting_node_ids: mappings.filter((mapping) => mapping.placement_type !== "Primary").map((mapping) => mapping.node_id),
      placement_type: primary?.placement_type || "Primary",
    });
    await loadAgentOrgNodes();
    setAgentDialog({ open: true, mode: "edit", agent });
  }

  async function saveAgent(event) {
    event.preventDefault();
    setFormError("");
    const editing = agentDialog.mode === "edit";
    const draft = event.nativeEvent.submitter?.dataset.intent === "draft";
    const requireGovernance = !draft && !editing;
    const displayName = agentForm.display_name.trim();
    const baseUrl = agentForm.base_url.trim();
    const publicKey = agentForm.public_key.trim();
    const secretKey = agentForm.secret_key.trim();
    if (!displayName) {
      setFormError("Display name is required.");
      return;
    }
    if (requireGovernance && !agentForm.agent_type) {
      setFormError("Agent Type is required.");
      return;
    }
    if (requireGovernance && !agentForm.use_case_summary.trim()) {
      setFormError("Use Case Summary is required.");
      return;
    }
    if (requireGovernance && !agentForm.primary_node_id) {
      setFormError("Primary Organization Node is required.");
      return;
    }
    if (requireGovernance && (!agentForm.business_owner.trim() || !agentForm.technical_owner.trim())) {
      setFormError("Business Owner and Technical Owner are required.");
      return;
    }
    if (requireGovernance && (!agentForm.data_classification || !agentForm.access_scope)) {
      setFormError("Data Classification and Access Scope are required.");
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
    setAgentSubmitting(true);
    const payload = {
      display_name: displayName,
      provider: "langfuse",
      base_url: baseUrl,
      metadata: editing ? agentDialog.agent?.metadata || {} : {},
      profile: { ...buildAgentProfile(agentForm), onboarding_status: draft || (editing && !isGovernanceComplete(agentForm)) ? "Draft" : "Submitted" },
      node_mappings: buildAgentNodeMappings(agentForm),
    };
    if (publicKey) payload.public_key = publicKey;
    if (secretKey) payload.secret_key = secretKey;

    try {
      setConnectionStatus(editing ? "Saving agent" : "Adding agent");
      const saved = await fetchJson(editing ? `/agents/${encodeURIComponent(agentForm.agent_id)}` : "/agents", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSelectedAgentId(saved.agent_id);
      setAgents((current) => {
        const remaining = current.filter((agent) => agent.agent_id !== saved.agent_id);
        return [saved, ...remaining];
      });
      if (!editing) {
        setMode("agents");
        setRuns([]);
        setEvents([]);
        setSelectedRunId("");
        setSelectedRunAgentId("");
        setSelectedEventId("");
        setSelectedView("transactions");
      }
      setAgentDialog({ open: false, mode: "create", agent: null });
      await loadAgents();
      setConnectionStatus("Live");
    } catch (error) {
      setFormError(error.message);
      setConnectionStatus("Save failed");
    } finally {
      setAgentSubmitting(false);
    }
  }

  async function deleteAgent(agent) {
    if (!window.confirm(`Delete ${agent.display_name}? Stored credentials will be removed.`)) return;
    await fetchJson(`/agents/${encodeURIComponent(agent.agent_id)}`, { method: "DELETE" });
    if (selectedAgentId === agent.agent_id) backToAgents();
    await loadAgents();
  }

  const metrics = selectedRunMetrics(selectedRun, events, costBreakdown);

  if (!auth?.token) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (authChecking) {
    return (
      <div className="auth-shell">
        <div className="auth-card compact">
          <span className="eyebrow">Security</span>
          <h1>Checking session</h1>
          <p>Validating your login before loading the workspace.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <h1>Agent Monitor</h1>
            <p>{connectionStatus} - {auth.email}</p>
          </div>
          <button className="icon-button" type="button" onClick={refreshCurrentView} title="Refresh" aria-label="Refresh">
            R
          </button>
        </header>
        <nav className="module-nav" aria-label="Modules">
          <button className={`module-item ${mode !== "settings" && mode !== "organization_graph" && mode !== "ai_intake" && mode !== "audit" ? "active" : ""}`} type="button" onClick={backToAgents}>
            <span>Agents</span>
            <small>Onboard and monitor</small>
          </button>
          <button className={`module-item ${mode === "ai_intake" ? "active" : ""}`} type="button" onClick={() => openAiIntake("new")}>
            <span>AI Agent Onboarding</span>
            <small>Requests and impact</small>
          </button>
          {mode === "ai_intake" && (
            <div className="submenu-list">
              {AI_INTAKE_SECTIONS.map((item) => (
                <button key={item.id} className={intakeSection === item.id ? "active" : ""} type="button" onClick={() => setIntakeSection(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <button className={`module-item ${mode === "organization_graph" ? "active" : ""}`} type="button" onClick={openOrganizationGraph}>
            <span>Organization Graph</span>
            <small>AI operating model</small>
          </button>
          <button className={`module-item ${mode === "audit" ? "active" : ""}`} type="button" onClick={openAudit}>
            <span>Audit</span>
            <small>Execution logs</small>
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
            <h2>{mode === "agent_detail" ? "Agent Detail" : mode === "settings" ? "Settings" : mode === "organization_graph" ? "Organization Graph" : mode === "ai_intake" ? "AI Agent Onboarding" : mode === "audit" ? "Audit" : "Agents"}</h2>
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
            {mode !== "settings" && mode !== "organization_graph" && mode !== "ai_intake" && mode !== "audit" && (
              <button className="command-button" type="button" onClick={openCreateDialog}>
                <span aria-hidden="true">+</span>
                Add Agent
              </button>
            )}
            <button className="command-button" type="button" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </section>

        {mode === "settings" ? (
          <ErrorBoundary label="Settings failed to render">
            <SettingsModule />
          </ErrorBoundary>
        ) : mode === "organization_graph" ? (
          <ErrorBoundary label="Organization Graph failed to render">
            <OrganizationGraphModule section={graphSection} onSection={setGraphSection} onOpenSettings={openSettings} onOpenAgent={openEditDialog} />
          </ErrorBoundary>
        ) : mode === "ai_intake" ? (
          <ErrorBoundary label="AI Intake failed to render">
            <AiAgentOnboardingModule section={intakeSection} onSection={setIntakeSection} selectedId={selectedIntakeId} onSelect={setSelectedIntakeId} />
          </ErrorBoundary>
        ) : mode === "audit" ? (
          <ErrorBoundary label="Audit failed to render">
            <AuditModule />
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
          submitting={agentSubmitting}
          orgNodes={agentOrgNodes}
          onChange={(patch) => setAgentForm((current) => ({ ...current, ...patch }))}
          onClose={() => setAgentDialog({ open: false, mode: "create", agent: null })}
          onSubmit={saveAgent}
        />
      )}
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState("email");
  const [devOtp, setDevOtp] = useState("");
  const [delivery, setDelivery] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function requestOtp(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await fetchJson("/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setDevOtp(result.dev_otp || "");
      setDelivery(result.delivery || "email");
      setStep("otp");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyOtp(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await fetchJson("/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });
      onLogin(result);
    } catch (verifyError) {
      setError(verifyError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="eyebrow">Secure Access</span>
          <h1>Agent Monitor</h1>
          <p>Sign in with your work email and one-time passcode.</p>
        </div>

        {step === "email" ? (
          <form className="auth-form" onSubmit={requestOtp}>
            <label>
              Email address
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                autoComplete="email"
                required
              />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="command-button primary" type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Send OTP"}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={verifyOtp}>
            <label>
              One-time passcode
              <input
                type="text"
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
            {delivery === "email" && <div className="otp-preview">OTP sent to {email.trim()}.</div>}
            {devOtp && (
              <div className="otp-preview">
                Email delivery is not configured. Use local development OTP: <strong>{devOtp}</strong>
              </div>
            )}
            {error && <div className="auth-error">{error}</div>}
            <div className="auth-actions">
              <button className="command-button primary" type="submit" disabled={submitting || otp.length !== 6}>
                {submitting ? "Verifying..." : "Verify and login"}
              </button>
              <button
                className="command-button"
                type="button"
                onClick={() => {
                  setStep("email");
                  setOtp("");
                  setDevOtp("");
                  setDelivery("");
                }}
              >
                Change email
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

function AuditModule() {
  const [events, setEvents] = useState([]);
  const [coverage, setCoverage] = useState({ functions: [] });
  const [summary, setSummary] = useState({ total: 0, errors: 0, ignored: 0, dropped: 0, byModule: {}, byStatus: {}, byEventType: {}, byFunction: {} });
  const [filters, setFilters] = useState({ status: "", module: "", eventType: "", function: "", query: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    loadAuditEvents();
    const timer = window.setInterval(loadAuditEvents, 10000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadAuditEvents() {
    try {
      const [data, coverageData, summaryData] = await Promise.all([fetchJson("/audit/events?limit=500"), fetchJson("/audit/coverage"), fetchJson("/audit/summary")]);
      setEvents(data);
      setCoverage(coverageData);
      setSummary(summaryData);
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  const options = useMemo(() => ({
    status: uniqueMergedValues(events, "status", summary.byStatus),
    module: uniqueMergedValues(events, "module", summary.byModule),
    eventType: uniqueMergedValues(events, "eventType", summary.byEventType),
    function: uniqueMergedValues(events, "function", summary.byFunction),
  }), [events, summary]);

  const visible = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return events.filter((event) =>
      (!filters.status || event.status === filters.status) &&
      (!filters.module || event.module === filters.module) &&
      (!filters.eventType || event.eventType === filters.eventType) &&
      (!filters.function || event.function === filters.function) &&
      (!query || JSON.stringify(event).toLowerCase().includes(query)),
    );
  }, [events, filters]);

  return (
    <section className="audit-page">
      <div className="aiom-header">
        <div>
          <h3>Audit</h3>
        <p>Runtime execution, API, UI, and backend function-call logs. Filters are generated dynamically from the log stream.</p>
        </div>
        <div className="aiom-actions">
          <button className="command-button" type="button" onClick={loadAuditEvents}>Refresh</button>
        </div>
      </div>
      {error && <div className="settings-error">{error}</div>}
      <div className="aiom-metrics">
        <div className="metric"><span>Total Events</span><strong>{summary.total || events.length}</strong></div>
        <div className="metric"><span>Loaded / Visible</span><strong>{events.length} / {visible.length}</strong></div>
        <div className="metric"><span>Errors</span><strong>{summary.errors || 0}</strong></div>
        <div className="metric"><span>Modules</span><strong>{options.module.length}</strong></div>
        <div className="metric"><span>Covered Functions</span><strong>{coverage.functions?.length || 0}</strong></div>
        <div className="metric"><span>Suppressed Noise</span><strong>{summary.ignored || 0}</strong></div>
        <div className="metric"><span>Dropped Events</span><strong>{summary.dropped || 0}</strong></div>
      </div>
      <div className="aiom-toolbar">
        <input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="Search audit events" />
        {["status", "module", "eventType", "function"].map((key) => (
          <select key={key} value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })}>
            <option value="">{key}</option>
            {options[key].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        ))}
      </div>
      <div className="aiom-table-wrap">
        <table className="aiom-table audit-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Type</th>
              <th>Module</th>
              <th>Function</th>
              <th>Message</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((event) => (
              <tr key={event.id}>
                <td>{formatDate(event.timestamp)}</td>
                <td><span className={`aiom-badge ${event.status}`}>{event.status}</span></td>
                <td>{event.eventType}</td>
                <td>{event.module}</td>
                <td>{event.function}</td>
                <td>{event.message}</td>
                <td><code>{JSON.stringify(event.metadata || {})}</code></td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan="7">No audit events match the current filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function uniqueMergedValues(rows, key, counts = {}) {
  return [...new Set([...rows.map((row) => row[key]).filter(Boolean), ...Object.keys(counts || {})])].sort();
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

const AGENT_TYPES = ["Assistant", "Analytics", "Workflow Automation", "Decision Support", "Autonomous Action"];
const INPUT_TYPES = ["Text", "Voice", "API", "File", "Event Trigger"];
const OUTPUT_TYPES = ["Recommendation", "Notification", "System Update", "Report", "Action Trigger"];
const DATA_CLASSIFICATIONS = ["Public", "Internal", "Confidential", "Restricted"];
const ACCESS_SCOPES = ["Read Only", "Limited Write", "Full Transactional"];
const CRITICALITIES = ["Low", "Medium", "High", "Critical"];
const PROCESS_DEPENDENCIES = ["Optional", "Supporting", "Core", "Mission Critical"];
const USER_IMPACTS = ["Internal Only", "Customer Facing", "Regulatory Facing"];
const FAILURE_IMPACTS = ["Minor Inconvenience", "Operational Delay", "Financial Loss", "Compliance Breach"];
const DOWNTIME_TOLERANCES = [">24 Hours", "8-24 Hours", "1-8 Hours", "<1 Hour"];
const AUTONOMY_LEVELS = ["Suggestion Only", "Human Approval Required", "Semi Autonomous", "Fully Autonomous"];
const DEPLOYMENT_ENVIRONMENTS = ["Development", "UAT", "Production"];
const DEPLOYMENT_STATUSES = ["Draft", "Testing", "Ready", "Live", "Retired"];

function AgentDialog({ mode, form, error, submitting, orgNodes, onChange, onClose, onSubmit }) {
  const editing = mode === "edit";
  const [nodeQuery, setNodeQuery] = useState("");
  const suggestedRisk = suggestAgentRisk(form);
  const visibleNodes = useMemo(() => {
    const query = nodeQuery.trim().toLowerCase();
    if (!query) return orgNodes;
    return orgNodes.filter((node) =>
      [node.node_name, node.node_code, node.node_type, breadcrumbText(node)].filter(Boolean).join(" ").toLowerCase().includes(query),
    );
  }, [nodeQuery, orgNodes]);
  const selectedPrimaryNode = orgNodes.find((node) => node.id === form.primary_node_id);
  const supportingNodes = orgNodes.filter((node) => form.supporting_node_ids.includes(node.id));

  function updateMultiValue(field, value, checked) {
    const current = new Set(form[field] || []);
    if (checked) current.add(value);
    else current.delete(value);
    onChange({ [field]: [...current] });
  }

  function updateSupportingNodes(event) {
    const ids = [...event.target.selectedOptions].map((option) => option.value).filter((id) => id !== form.primary_node_id);
    onChange({ supporting_node_ids: ids });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="agent-dialog onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
        <form onSubmit={onSubmit} noValidate>
          <div className="dialog-header">
            <div>
              <h3 id="agent-dialog-title">{editing ? "Edit Agent" : "Add Agent"}</h3>
              <p>{editing ? "Update governance, mappings, or credentials." : "Register an agent with business ownership, controls, and operating profile."}</p>
            </div>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={submitting}>
              x
            </button>
          </div>

          {editing && (
            <div className="readonly-field">
              <span>Agent ID</span>
              <code>{form.agent_id}</code>
            </div>
          )}

          <div className="onboarding-risk-strip">
            <div>
              <span>Suggested Risk</span>
              <strong className={`risk-chip ${suggestedRisk.toLowerCase()}`}>{suggestedRisk}</strong>
            </div>
            <div>
              <span>Primary Mapping</span>
              <strong>{selectedPrimaryNode ? breadcrumbText(selectedPrimaryNode) : "Required"}</strong>
            </div>
            <div>
              <span>Readiness</span>
              <strong>{form.deployment_environment} / {form.deployment_status}</strong>
            </div>
          </div>

          <details className="onboarding-section" open>
            <summary>1. Basic Details</summary>
            <div className="dialog-grid">
              <label>Agent Name<input value={form.display_name} onChange={(event) => onChange({ display_name: event.target.value })} required /></label>
              <label>Agent Code<input value={form.agent_code} onChange={(event) => onChange({ agent_code: event.target.value })} placeholder="TRN-AGT-001" /></label>
              <label>Agent Type<SelectField value={form.agent_type} options={AGENT_TYPES} onChange={(value) => onChange({ agent_type: value })} required /></label>
              <label>Lifecycle Status<SelectField value={form.lifecycle_status} options={DEPLOYMENT_STATUSES} onChange={(value) => onChange({ lifecycle_status: value })} /></label>
            </div>
            <label>Agent Description<textarea value={form.agent_description} onChange={(event) => onChange({ agent_description: event.target.value })} rows={2} /></label>
            <label>Use Case Summary<textarea value={form.use_case_summary} onChange={(event) => onChange({ use_case_summary: event.target.value })} rows={2} required /></label>
            <label>Business Objective<textarea value={form.business_objective} onChange={(event) => onChange({ business_objective: event.target.value })} rows={2} /></label>
          </details>

          <details className="onboarding-section" open>
            <summary>2. Business Mapping</summary>
            <input type="search" value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} placeholder="Search hierarchy by node, code, owner, or type..." />
            <div className="dialog-grid">
              <label>Primary Organization Node<SelectField value={form.primary_node_id} options={visibleNodes.map(nodeOption)} onChange={(value) => onChange({ primary_node_id: value, supporting_node_ids: form.supporting_node_ids.filter((id) => id !== value) })} required /></label>
              <label>Placement Type<SelectField value={form.placement_type} options={["Primary", "Supporting", "Shared"]} onChange={(value) => onChange({ placement_type: value })} /></label>
            </div>
            {selectedPrimaryNode && <div className="breadcrumb-preview">{breadcrumbText(selectedPrimaryNode)} <span>{selectedPrimaryNode.node_type}</span></div>}
            <label>Supporting Nodes<select multiple value={form.supporting_node_ids} onChange={updateSupportingNodes}>{visibleNodes.filter((node) => node.id !== form.primary_node_id).map((node) => <option key={node.id} value={node.id}>{nodeOption(node).label}</option>)}</select></label>
            {!!supportingNodes.length && <div className="selected-node-list">{supportingNodes.map((node) => <span key={node.id}>{breadcrumbText(node)} <small>{node.node_type}</small></span>)}</div>}
            <div className="dialog-grid">
              <label>Business Function<input value={form.business_function} onChange={(event) => onChange({ business_function: event.target.value })} /></label>
              <label>Process Area<input value={form.process_area} onChange={(event) => onChange({ process_area: event.target.value })} /></label>
              <label>Department Owner<input value={form.department_owner} onChange={(event) => onChange({ department_owner: event.target.value })} /></label>
            </div>
          </details>

          <details className="onboarding-section">
            <summary>3. Ownership</summary>
            <div className="dialog-grid">
              <label>Business Owner<input value={form.business_owner} onChange={(event) => onChange({ business_owner: event.target.value })} required /></label>
              <label>Technical Owner<input value={form.technical_owner} onChange={(event) => onChange({ technical_owner: event.target.value })} required /></label>
              <label>Operational Support Owner<input value={form.operational_support_owner} onChange={(event) => onChange({ operational_support_owner: event.target.value })} /></label>
              <label>Escalation Contact<input value={form.escalation_contact} onChange={(event) => onChange({ escalation_contact: event.target.value })} /></label>
              <label>Support Team<input value={form.support_team} onChange={(event) => onChange({ support_team: event.target.value })} /></label>
            </div>
          </details>

          <details className="onboarding-section">
            <summary>4. Capability & Function</summary>
            <label>Agent Capability Type<SelectField value={form.capability_type} options={AGENT_TYPES} onChange={(value) => onChange({ capability_type: value })} /></label>
            <CheckboxGroup title="Input Types" values={INPUT_TYPES} selected={form.input_types} onChange={(value, checked) => updateMultiValue("input_types", value, checked)} />
            <CheckboxGroup title="Output Types" values={OUTPUT_TYPES} selected={form.output_types} onChange={(value, checked) => updateMultiValue("output_types", value, checked)} />
            <label>Actions Performed<textarea value={form.actions_performed} onChange={(event) => onChange({ actions_performed: event.target.value })} rows={2} /></label>
            <div className="dialog-grid">
              <label>External Tools Used<input value={form.external_tools_used} onChange={(event) => onChange({ external_tools_used: event.target.value })} /></label>
              <label>APIs Used<input value={form.apis_used} onChange={(event) => onChange({ apis_used: event.target.value })} /></label>
              <label>Connected Systems<input value={form.connected_systems} onChange={(event) => onChange({ connected_systems: event.target.value })} /></label>
            </div>
          </details>

          <details className="onboarding-section" open>
            <summary>5. Data & Access</summary>
            <div className="dialog-grid">
              <label>Data Classification<SelectField value={form.data_classification} options={DATA_CLASSIFICATIONS} onChange={(value) => onChange({ data_classification: value })} required /></label>
              <label>Access Scope<SelectField value={form.access_scope} options={ACCESS_SCOPES} onChange={(value) => onChange({ access_scope: value })} required /></label>
            </div>
            <label>Data Sources<input value={form.data_sources} onChange={(event) => onChange({ data_sources: event.target.value })} /></label>
            <div className="toggle-row">
              <label><input type="checkbox" checked={form.pii_usage} onChange={(event) => onChange({ pii_usage: event.target.checked })} /> PII Usage</label>
              <label><input type="checkbox" checked={form.sensitive_data_usage} onChange={(event) => onChange({ sensitive_data_usage: event.target.checked })} /> Sensitive Data Usage</label>
            </div>
            <div className="dialog-grid">
              <label>Read Access Systems<input value={form.read_access_systems} onChange={(event) => onChange({ read_access_systems: event.target.value })} /></label>
              <label>Write Access Systems<input value={form.write_access_systems} onChange={(event) => onChange({ write_access_systems: event.target.value })} /></label>
            </div>
          </details>

          <details className="onboarding-section" open>
            <summary>6. Risk & Criticality</summary>
            <div className="dialog-grid">
              <label>Business Criticality<SelectField value={form.business_criticality} options={CRITICALITIES} onChange={(value) => onChange({ business_criticality: value })} /></label>
              <label>Process Dependency<SelectField value={form.process_dependency} options={PROCESS_DEPENDENCIES} onChange={(value) => onChange({ process_dependency: value })} /></label>
              <label>User Impact<SelectField value={form.user_impact} options={USER_IMPACTS} onChange={(value) => onChange({ user_impact: value })} /></label>
              <label>Failure Impact<SelectField value={form.failure_impact} options={FAILURE_IMPACTS} onChange={(value) => onChange({ failure_impact: value })} /></label>
              <label>Downtime Tolerance<SelectField value={form.downtime_tolerance} options={DOWNTIME_TOLERANCES} onChange={(value) => onChange({ downtime_tolerance: value })} /></label>
              <label>Autonomy Level<SelectField value={form.autonomy_level} options={AUTONOMY_LEVELS} onChange={(value) => onChange({ autonomy_level: value })} /></label>
              <label>Risk Level<SelectField value={form.risk_level} options={CRITICALITIES} onChange={(value) => onChange({ risk_level: value })} /></label>
            </div>
            <div className="dynamic-warning">System suggested criticality: <strong>{suggestedRisk}</strong></div>
          </details>

          <details className="onboarding-section">
            <summary>7. Controls & Governance</summary>
            <div className="toggle-row wrap">
              {[
                ["human_approval_required", "Human In The Loop Required"],
                ["approval_required_before_execution", "Approval Required Before Execution"],
                ["audit_logging_required", "Audit Logging Required"],
                ["monitoring_required", "Monitoring Required"],
                ["escalation_required", "Escalation Required"],
                ["fallback_process_available", "Fallback Process Available"],
              ].map(([field, label]) => <label key={field}><input type="checkbox" checked={!!form[field]} onChange={(event) => onChange({ [field]: event.target.checked })} /> {label}</label>)}
            </div>
            <div className="dialog-grid">
              <label>Compliance Policy Reference<input value={form.compliance_policy_reference} onChange={(event) => onChange({ compliance_policy_reference: event.target.value })} /></label>
              <label>Regulatory Impact<input value={form.regulatory_impact} onChange={(event) => onChange({ regulatory_impact: event.target.value })} /></label>
              <label>Audit Requirement<input value={form.audit_requirement} onChange={(event) => onChange({ audit_requirement: event.target.value })} /></label>
            </div>
          </details>

          <details className="onboarding-section">
            <summary>8. Operational Readiness</summary>
            <div className="dialog-grid">
              <label>Deployment Environment<SelectField value={form.deployment_environment} options={DEPLOYMENT_ENVIRONMENTS} onChange={(value) => onChange({ deployment_environment: value })} /></label>
              <label>Deployment Status<SelectField value={form.deployment_status} options={DEPLOYMENT_STATUSES} onChange={(value) => onChange({ deployment_status: value })} /></label>
              <label>Monitoring SLA<input value={form.monitoring_sla} onChange={(event) => onChange({ monitoring_sla: event.target.value })} /></label>
              <label>Support SLA<input value={form.support_sla} onChange={(event) => onChange({ support_sla: event.target.value })} /></label>
              <label>Incident Severity Level<input value={form.incident_severity_level} onChange={(event) => onChange({ incident_severity_level: event.target.value })} /></label>
              <label>Runtime Dependencies<input value={form.runtime_dependencies} onChange={(event) => onChange({ runtime_dependencies: event.target.value })} /></label>
              <label>Linked Infrastructure<input value={form.linked_infrastructure} onChange={(event) => onChange({ linked_infrastructure: event.target.value })} /></label>
              <label>Linked Models / LLMs<input value={form.linked_models} onChange={(event) => onChange({ linked_models: event.target.value })} /></label>
            </div>
          </details>

          <details className="onboarding-section" open>
            <summary>Langfuse Credentials</summary>
            <label>Langfuse base URL<input value={form.base_url} onChange={(event) => onChange({ base_url: event.target.value })} required /></label>
            <div className="dialog-grid">
              <label>Public key<input value={form.public_key} onChange={(event) => onChange({ public_key: event.target.value })} placeholder={editing ? "Leave blank to keep current key" : "pk-lf-..."} required={!editing} /></label>
              <label>Secret key<input type="password" value={form.secret_key} onChange={(event) => onChange({ secret_key: event.target.value })} placeholder={editing ? "Leave blank to keep current key" : "sk-lf-..."} required={!editing} /></label>
            </div>
          </details>

          <div className="form-error" role="alert">
            {error}
          </div>

          <div className="dialog-actions">
            <button className="command-button" type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button className="command-button" type="submit" data-intent="draft" disabled={submitting} onClick={() => onChange({ lifecycle_status: "Draft", deployment_status: "Draft" })}>
              Save Draft
            </button>
            <button className="command-button primary" type="submit" disabled={submitting}>
              {submitting ? "Saving..." : editing ? "Save Changes" : "Add Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SelectField({ value, options, onChange, required = false }) {
  const normalized = options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  return (
    <select value={value || ""} onChange={(event) => onChange(event.target.value)} required={required}>
      <option value="">Select...</option>
      {normalized.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

function CheckboxGroup({ title, values, selected, onChange }) {
  return (
    <div className="checkbox-group">
      <span>{title}</span>
      <div>
        {values.map((value) => (
          <label key={value}>
            <input type="checkbox" checked={(selected || []).includes(value)} onChange={(event) => onChange(value, event.target.checked)} />
            {value}
          </label>
        ))}
      </div>
    </div>
  );
}

function nodeOption(node) {
  return { value: node.id, label: `${breadcrumbText(node)} (${node.node_type || node.nodeType})` };
}

function breadcrumbText(node) {
  return (node.path || [{ node_name: node.node_name }]).map((part) => part.node_name).join(" > ");
}

function buildAgentNodeMappings(form) {
  const mappings = [];
  if (form.primary_node_id) mappings.push({ node_id: form.primary_node_id, placement_type: "Primary", status: "Active" });
  for (const nodeId of form.supporting_node_ids || []) {
    if (nodeId && nodeId !== form.primary_node_id) mappings.push({ node_id: nodeId, placement_type: form.placement_type === "Shared" ? "Shared" : "Supporting", status: "Active" });
  }
  return mappings;
}

function buildAgentProfile(form) {
  const keys = Object.keys(EMPTY_AGENT_FORM).filter((key) => !["display_name", "base_url", "public_key", "secret_key", "primary_node_id", "supporting_node_ids", "placement_type"].includes(key));
  const profile = {};
  for (const key of keys) profile[key] = form[key];
  profile.suggested_risk_level = suggestAgentRisk(form);
  return profile;
}

function isGovernanceComplete(form) {
  return Boolean(
    form.agent_type &&
      form.use_case_summary?.trim() &&
      form.primary_node_id &&
      form.business_owner?.trim() &&
      form.technical_owner?.trim() &&
      form.data_classification &&
      form.access_scope,
  );
}

function suggestAgentRisk(form) {
  let score = 0;
  if (form.autonomy_level === "Semi Autonomous") score += 2;
  if (form.autonomy_level === "Fully Autonomous") score += 3;
  if (form.data_classification === "Confidential") score += 2;
  if (form.data_classification === "Restricted") score += 3;
  if (form.access_scope === "Limited Write") score += 2;
  if (form.access_scope === "Full Transactional") score += 3;
  if (form.process_dependency === "Core") score += 2;
  if (form.process_dependency === "Mission Critical") score += 3;
  if (["Customer Facing", "Regulatory Facing"].includes(form.user_impact)) score += 2;
  if (form.pii_usage || form.sensitive_data_usage) score += 1;
  if (score >= 10) return "Critical";
  if (score >= 7) return "High";
  if (score >= 3) return "Medium";
  return "Low";
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

const GRAPH_SECTIONS = [
  ["overview", "Overview"],
  ["canvas", "Graph Canvas"],
  ["metrics", "Metrics View"],
  ["relationships", "Agent Relationship View"],
  ["explorer", "Node Detail Explorer"],
];
const GRAPH_KPIS = [
  ["cost", "Cost"],
  ["tokens", "Tokens"],
  ["latency", "Latency"],
  ["executions", "Executions"],
  ["success_rate", "Success Rate"],
  ["error_rate", "Error Rate"],
  ["api_calls", "API Calls"],
  ["runtime_duration", "Runtime Duration"],
  ["active_users", "Active Users"],
];
const GRAPH_AGGREGATIONS = ["direct", "rollup", "combined"];
const GRAPH_LAYOUTS = ["funnel roll-up", "vertical hierarchy", "horizontal hierarchy", "compact", "expanded", "grouped by business area", "grouped by node type"];

function OrganizationGraphModule({ section, onSection, onOpenSettings, onOpenAgent }) {
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kpi, setKpi] = useState("cost");
  const [aggregation, setAggregation] = useState("combined");
  const [layout, setLayout] = useState("funnel roll-up");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ nodeType: "", deploymentStatus: "", riskLevel: "", activeState: "", hasMetrics: "" });
  const [selectedId, setSelectedId] = useState("");
  const [collapsed, setCollapsed] = useState(new Set());
  const [showAgents, setShowAgents] = useState(true);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    loadGraph();
  }, []);

  async function loadGraph() {
    try {
      setLoading(true);
      const data = await fetchJson("/organization-graph");
      setGraph(data);
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  const graphModel = useMemo(() => {
    if (!graph) return { nodes: [], edges: [], positioned: [], bounds: { width: 1200, height: 700 } };
    const filtered = filterGraphData(graph, filters, query, collapsed, showAgents);
    return layoutGraph(filtered.nodes, filtered.edges, layout);
  }, [graph, filters, query, collapsed, showAgents, layout]);
  const selected = graphModel.nodes.find((node) => node.id === selectedId) || null;
  const overview = graph?.metrics?.overview || {};

  function toggleCollapse(nodeId) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function exportMetricsCsv() {
    const rows = graphModel.nodes.map((node) => {
      const metric = graphMetric(node, kpi, aggregation);
      return [node.id, node.type, node.label, metric].map(csvCell).join(",");
    });
    downloadText("organization-graph-metrics.csv", ["id,type,label,metric", ...rows].join("\n"));
  }

  function exportSvg() {
    const svg = document.querySelector(".org-graph-svg")?.outerHTML || "";
    downloadText("organization-graph.svg", svg);
  }

  if (loading) return <div className="empty-state">Loading organization graph...</div>;
  if (error) return <div className="empty-state">Could not load organization graph: {error}</div>;

  return (
    <section className="org-graph-module">
      <div className="graph-subnav">
        {GRAPH_SECTIONS.map(([id, label]) => (
          <button key={id} className={`module-item ${section === id ? "active" : ""}`} type="button" onClick={() => onSection(id)}>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <GraphToolbar
        kpi={kpi}
        aggregation={aggregation}
        layout={layout}
        query={query}
        filters={filters}
        graph={graph}
        showAgents={showAgents}
        onKpi={setKpi}
        onAggregation={setAggregation}
        onLayout={setLayout}
        onQuery={setQuery}
        onFilters={setFilters}
        onRefresh={loadGraph}
        onReset={() => {
          setQuery("");
          setFilters({ nodeType: "", deploymentStatus: "", riskLevel: "", activeState: "", hasMetrics: "" });
          setCollapsed(new Set());
          setScale(1);
        }}
        onExportCsv={exportMetricsCsv}
        onExportSvg={exportSvg}
        onShowAgents={setShowAgents}
      />

      {section === "overview" && <GraphOverview overview={overview} graph={graph} kpi={kpi} />}
      {section === "canvas" && (
        <div className="graph-workbench">
          <GraphCanvas
            model={graphModel}
            kpi={kpi}
            aggregation={aggregation}
            selectedId={selectedId}
            selected={selected}
            layout={layout}
            scale={scale}
            onScale={setScale}
            onSelect={setSelectedId}
            onToggleCollapse={toggleCollapse}
            onOpenSettings={onOpenSettings}
            onOpenAgent={onOpenAgent}
          />
        </div>
      )}
      {section === "metrics" && <GraphMetricsView model={graphModel} kpi={kpi} aggregation={aggregation} />}
      {section === "relationships" && <AgentRelationshipView model={graphModel} />}
      {section === "explorer" && <NodeDetailExplorer model={graphModel} selected={selected} onSelect={setSelectedId} graph={graph} />}
    </section>
  );
}

function GraphToolbar({ kpi, aggregation, layout, query, filters, graph, showAgents, onKpi, onAggregation, onLayout, onQuery, onFilters, onRefresh, onReset, onExportCsv, onExportSvg, onShowAgents }) {
  return (
    <div className="graph-toolbar">
      <select value={kpi} onChange={(event) => onKpi(event.target.value)}>{GRAPH_KPIS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <select value={aggregation} onChange={(event) => onAggregation(event.target.value)}>{GRAPH_AGGREGATIONS.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select>
      <select value={layout} onChange={(event) => onLayout(event.target.value)}>{GRAPH_LAYOUTS.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select>
      <input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search and focus node or agent..." />
      <select value={filters.nodeType} onChange={(event) => onFilters({ ...filters, nodeType: event.target.value })}>
        <option value="">All node types</option>
        {(graph.filters?.nodeTypes || []).map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select value={filters.deploymentStatus} onChange={(event) => onFilters({ ...filters, deploymentStatus: event.target.value })}>
        <option value="">All deployments</option>
        {(graph.filters?.deploymentStatuses || []).map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select value={filters.riskLevel} onChange={(event) => onFilters({ ...filters, riskLevel: event.target.value })}>
        <option value="">All risks</option>
        {(graph.filters?.riskLevels || []).map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select value={filters.hasMetrics} onChange={(event) => onFilters({ ...filters, hasMetrics: event.target.value })}>
        <option value="">Metrics any</option>
        <option value="yes">Has metrics</option>
        <option value="no">No metrics</option>
      </select>
      <label className="toolbar-toggle"><input type="checkbox" checked={showAgents} onChange={(event) => onShowAgents(event.target.checked)} /> Agents</label>
      <button className="mini-button" type="button" onClick={onRefresh}>Refresh</button>
      <button className="mini-button" type="button" onClick={onReset}>Reset</button>
      <button className="mini-button" type="button" onClick={onExportSvg}>SVG</button>
      <button className="mini-button" type="button" onClick={onExportCsv}>CSV</button>
    </div>
  );
}

function GraphOverview({ overview, graph }) {
  const cards = [
    ["Org Nodes", overview.totalOrganizationNodes || 0],
    ["AI Agents", overview.totalAiAgents || 0],
    ["Active Agents", overview.activeAgents || 0],
    ["Critical Agents", overview.criticalAgents || 0],
    ["High Risk", overview.highRiskAgents || 0],
    ["Production", overview.productionAgents || 0],
    ["Tokens", formatNumber(overview.totalTokenUsage || 0)],
    ["Runtime Cost", formatCost(overview.totalRuntimeCost || 0)],
    ["Avg Latency", formatDuration(overview.averageLatency || 0)],
    ["Executions", overview.totalExecutions || 0],
  ];
  return (
    <div className="graph-overview">
      <div className="graph-summary-grid">{cards.map(([label, value]) => <div key={label} className="metric"><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="graph-chart-grid">
        <MiniBarChart title="Cost by Business Area" rows={(overview.topConsumingDepartments || []).map((row) => ({ label: row.name, value: row.cost }))} valueFormat={formatCost} />
        <MiniBarChart title="Top Consuming Agents" rows={(overview.topConsumingAgents || []).map((row) => ({ label: row.agentId, value: row.cost }))} valueFormat={formatCost} />
        <MiniBarChart title="Risk Distribution" rows={objectRows(overview.riskDistribution)} />
        <MiniBarChart title="Deployment Status" rows={objectRows(overview.deploymentStatusDistribution)} />
        <MiniBarChart title="Agent Distribution by Department" rows={Object.entries(overview.mappedAgentsByNode || {}).map(([id, value]) => ({ label: graph.nodes.find((node) => node.entityId === id)?.label || id, value }))} />
        <MiniBarChart title="Token Usage Trend" rows={(overview.topConsumingAgents || []).map((row) => ({ label: row.agentId, value: row.tokens }))} valueFormat={formatNumber} />
      </div>
    </div>
  );
}

function MiniBarChart({ title, rows, valueFormat = formatNumber }) {
  const max = Math.max(...rows.map((row) => Number(row.value) || 0), 1);
  return (
    <article className="graph-chart">
      <h3>{title}</h3>
      {!rows.length && <div className="empty-state">No data</div>}
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <span>{row.label}</span>
          <div><i style={{ width: `${Math.max(4, ((Number(row.value) || 0) / max) * 100)}%` }} /></div>
          <strong>{valueFormat(row.value || 0)}</strong>
        </div>
      ))}
    </article>
  );
}

function GraphCanvas({ model, kpi, aggregation, selectedId, selected, layout, scale, onScale, onSelect, onToggleCollapse, onOpenSettings, onOpenAgent }) {
  const selectedPosition = model.positioned.find((node) => node.id === selectedId);
  const funnel = layout.includes("funnel");
  const orgCount = model.nodes.filter((node) => node.type === "organization").length;
  const agentCount = model.nodes.filter((node) => node.type === "agent").length;
  return (
    <div className="graph-canvas-frame">
      <div className="graph-canvas-top">
        <div>
          <span>Operating Model Map</span>
          <strong>{orgCount} org nodes / {agentCount} agents</strong>
        </div>
        <div className="graph-legend" aria-label="Graph legend">
          <span><i className="legend-org" /> Organization</span>
          <span><i className="legend-agent" /> Agent</span>
          <span><i className="legend-risk" /> Higher risk</span>
        </div>
      </div>
      <div className="graph-canvas-shell">
        <div className="canvas-controls">
          <button className="mini-button" type="button" onClick={() => onScale(Math.min(1.8, scale + 0.1))}>Zoom +</button>
          <button className="mini-button" type="button" onClick={() => onScale(Math.max(0.45, scale - 0.1))}>Zoom -</button>
          <button className="mini-button" type="button" onClick={() => onScale(1)}>Reset</button>
        </div>
        <svg
          className="org-graph-svg"
          viewBox={`0 0 ${model.bounds.width} ${model.bounds.height}`}
          style={{ width: `${model.bounds.width * scale}px`, height: `${model.bounds.height * scale}px` }}
        >
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" /></marker>
            <linearGradient id="orgNodeFill" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stopColor="#f8fbff" /><stop offset="100%" stopColor="#eef7ff" /></linearGradient>
            <linearGradient id="agentNodeFill" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stopColor="#f5fffb" /><stop offset="100%" stopColor="#e9f8f4" /></linearGradient>
            <linearGradient id="riskNodeFill" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stopColor="#fffaf0" /><stop offset="100%" stopColor="#fff1e6" /></linearGradient>
          </defs>
          {model.edges.map((edge) => {
            const source = model.positioned.find((node) => node.id === edge.source);
            const target = model.positioned.find((node) => node.id === edge.target);
            if (!source || !target) return null;
            const from = funnel ? target : source;
            const to = funnel ? source : target;
            const fromY = funnel ? from.y : from.y + 112;
            const toY = funnel ? to.y + 112 : to.y;
            return <path key={edge.id} className={`graph-edge ${edge.type} ${funnel ? "funnel" : ""}`} d={`M${from.x + 110},${fromY} C${from.x + 110},${(fromY + toY) / 2} ${to.x + 110},${(fromY + toY) / 2} ${to.x + 110},${toY}`} markerEnd="url(#arrow)" />;
          })}
          {model.positioned.map((node) => <GraphNode key={node.id} node={node} kpi={kpi} aggregation={aggregation} selected={node.id === selectedId} onSelect={onSelect} onToggleCollapse={onToggleCollapse} />)}
        </svg>
        {selected && selectedPosition && (
          <GraphHoverPanel
            selected={selected}
            position={selectedPosition}
            onClose={() => onSelect("")}
            onOpenSettings={onOpenSettings}
            onOpenAgent={onOpenAgent}
          />
        )}
        <div className="graph-minimap">{model.positioned.slice(0, 90).map((node) => <span key={node.id} className={node.type} style={{ left: `${(node.x / model.bounds.width) * 100}%`, top: `${(node.y / model.bounds.height) * 100}%` }} />)}</div>
      </div>
    </div>
  );
}

function GraphNode({ node, kpi, aggregation, selected, onSelect, onToggleCollapse }) {
  const metric = graphMetric(node, kpi, aggregation);
  const meta = node.metadata || {};
  const risk = meta.suggested_risk_level || meta.risk_level || meta.business_criticality || "Low";
  const isAgent = node.type === "agent";
  const subtitle = isAgent ? `${meta.agent_type || "Agent"} / ${meta.deployment_status || "Draft"}` : `${meta.node_code || ""} / ${meta.node_type || ""}`;
  const owner = isAgent ? meta.business_owner || `Risk ${risk}` : meta.owner || "No owner";
  return (
    <g
      className={`graph-node ${node.type} ${selected ? "selected" : ""} ${risk.toLowerCase()}`}
      transform={`translate(${node.x}, ${node.y})`}
      onClick={() => onSelect(node.id)}
      onMouseEnter={() => onSelect(node.id)}
    >
      <rect width="220" height="112" rx="8" />
      <rect className="node-accent" width="220" height="8" rx="8" />
      <circle className="node-dot" cx="18" cy="28" r="5" />
      <text x="30" y="32" className="node-title">{truncateText(node.label, 25)}</text>
      <text x="12" y="54" className="node-subtitle">{truncateText(subtitle, 34)}</text>
      <text x="12" y="73">{truncateText(owner, 34)}</text>
      <rect className="node-kpi-pill" x="12" y="84" width="116" height="20" rx="10" />
      <text x="22" y="98" className="node-kpi">{kpiLabel(kpi)}: {formatGraphMetric(kpi, metric)}</text>
      <text x="140" y="98" className="node-foot">{isAgent ? risk : `Agents ${meta.totalMappedAgents || 0}`}</text>
      {node.type === "organization" && <text className="collapse-hit" x="196" y="24" onClick={(event) => { event.stopPropagation(); onToggleCollapse(node.id); }}>+/-</text>}
    </g>
  );
}

function GraphHoverPanel({ selected, position, onClose, onOpenSettings, onOpenAgent }) {
  const meta = selected.metadata || {};
  const metric = selected.type === "organization" ? meta.metrics?.combined || {} : meta.metrics || {};
  const left = Math.min(position.x + 232, 920);
  const top = Math.max(12, position.y - 8);
  return (
    <div className="graph-hover-panel" style={{ left, top }}>
      <button className="mini-button" type="button" onClick={onClose}>x</button>
      <span className={`provider-pill ${selected.type}`}>{selected.type}</span>
      <h3>{selected.label}</h3>
      <p>{selected.type === "organization" ? `${meta.node_code || ""} - ${meta.node_type || ""}` : `${meta.agent_type || "Agent"} - ${meta.deployment_status || "Draft"}`}</p>
      <dl className="agent-card-details">
        <div><dt>Owner</dt><dd>{meta.owner || meta.business_owner || "Not assigned"}</dd></div>
        <div><dt>Cost</dt><dd>{formatCost(metric.cost || 0)}</dd></div>
        <div><dt>Tokens</dt><dd>{formatNumber(metric.tokens || 0)}</dd></div>
        <div><dt>Executions</dt><dd>{metric.executions || 0}</dd></div>
        <div><dt>Success</dt><dd>{formatPercent(metric.success_rate || 0)}</dd></div>
      </dl>
      <div className="hover-actions">
        {selected.type === "organization" ? (
          <button className="mini-button" type="button" onClick={onOpenSettings}>Settings</button>
        ) : (
          <button className="mini-button" type="button" onClick={() => onOpenAgent({ agent_id: selected.entityId, ...meta })}>Onboarding</button>
        )}
        <button className="mini-button" type="button" onClick={() => downloadText(`${selected.entityId}-metrics.csv`, `metric,value\ncost,${metric.cost || 0}\ntokens,${metric.tokens || 0}\nexecutions,${metric.executions || 0}`)}>Export</button>
      </div>
    </div>
  );
}

function GraphDetailPanel({ selected, graph, onOpenSettings, onOpenAgent }) {
  if (!selected) return <aside className="graph-detail-panel"><h3>Detail Explorer</h3><p>Select an organization node or agent.</p></aside>;
  const meta = selected.metadata || {};
  const metric = selected.type === "organization" ? meta.metrics?.combined || {} : meta.metrics || {};
  return (
    <aside className="graph-detail-panel">
      <h3>{selected.label}</h3>
      <span className={`provider-pill ${selected.type}`}>{selected.type}</span>
      <dl className="agent-card-details">
        <div><dt>ID</dt><dd>{selected.entityId}</dd></div>
        <div><dt>Status</dt><dd>{meta.status || meta.deployment_status || "Draft"}</dd></div>
        <div><dt>Owner</dt><dd>{meta.owner || meta.business_owner || "Not assigned"}</dd></div>
        <div><dt>Cost</dt><dd>{formatCost(metric.cost || 0)}</dd></div>
        <div><dt>Tokens</dt><dd>{formatNumber(metric.tokens || 0)}</dd></div>
        <div><dt>Executions</dt><dd>{metric.executions || 0}</dd></div>
      </dl>
      {selected.type === "organization" ? (
        <button className="command-button" type="button" onClick={onOpenSettings}>Navigate to Settings</button>
      ) : (
        <button className="command-button" type="button" onClick={() => onOpenAgent({ agent_id: selected.entityId, ...meta })}>Navigate to Onboarding</button>
      )}
      <button className="command-button" type="button" onClick={() => downloadText(`${selected.entityId}-metrics.csv`, `metric,value\ncost,${metric.cost || 0}\ntokens,${metric.tokens || 0}\nexecutions,${metric.executions || 0}`)}>Export Subtree Metrics</button>
    </aside>
  );
}

function GraphMetricsView({ model, kpi, aggregation }) {
  return (
    <div className="graph-table-wrap">
      <table className="run-table">
        <thead><tr><th>Entity</th><th>Type</th><th>{kpiLabel(kpi)}</th><th>Cost</th><th>Tokens</th><th>Executions</th><th>Success</th></tr></thead>
        <tbody>{model.nodes.map((node) => {
          const metric = node.type === "organization" ? node.metadata.metrics?.[aggregation] || {} : node.metadata.metrics || {};
          return <tr key={node.id}><td>{node.label}</td><td>{node.type}</td><td>{formatGraphMetric(kpi, graphMetric(node, kpi, aggregation))}</td><td>{formatCost(metric.cost || 0)}</td><td>{formatNumber(metric.tokens || 0)}</td><td>{metric.executions || 0}</td><td>{formatPercent(metric.success_rate || 0)}</td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function AgentRelationshipView({ model }) {
  const agents = model.nodes.filter((node) => node.type === "agent");
  return <div className="relationship-grid">{agents.map((node) => <article key={node.id} className="agent-card"><h4>{node.label}</h4><p>{node.metadata.business_owner || "No business owner"} / {node.metadata.technical_owner || "No technical owner"}</p><dl className="agent-card-details"><div><dt>Systems</dt><dd>{node.metadata.connected_systems || "Not mapped"}</dd></div><div><dt>Models</dt><dd>{node.metadata.linked_models || node.metadata.provider || "Not mapped"}</dd></div><div><dt>Risk</dt><dd>{node.metadata.suggested_risk_level || node.metadata.risk_level || "Low"}</dd></div></dl></article>)}</div>;
}

function NodeDetailExplorer({ model, selected, onSelect, graph }) {
  return (
    <div className="explorer-grid">
      <div className="graph-table-wrap">
        <table className="run-table"><thead><tr><th>Node</th><th>Type</th><th>Status</th><th>Agents</th></tr></thead><tbody>{model.nodes.filter((node) => node.type === "organization").map((node) => <tr key={node.id} onClick={() => onSelect(node.id)}><td>{node.label}</td><td>{node.metadata.node_type}</td><td>{node.metadata.status}</td><td>{node.metadata.totalMappedAgents}</td></tr>)}</tbody></table>
      </div>
      <GraphDetailPanel selected={selected} graph={graph} onOpenSettings={() => {}} onOpenAgent={() => {}} />
    </div>
  );
}

function filterGraphData(graph, filters, query, collapsed, showAgents) {
  const queryText = query.trim().toLowerCase();
  const visible = new Set();
  const orgNodes = graph.nodes.filter((node) => node.type === "organization");
  const childEdges = graph.edges.filter((edge) => edge.type === "hierarchy");
  const childrenBySource = childEdges.reduce((map, edge) => {
    if (!map.has(edge.source)) map.set(edge.source, []);
    map.get(edge.source).push(edge.target);
    return map;
  }, new Map());
  function includeOrg(id, hiddenByParent = false) {
    if (hiddenByParent) return;
    visible.add(id);
    const nextHidden = collapsed.has(id);
    for (const child of childrenBySource.get(id) || []) includeOrg(child, nextHidden);
  }
  for (const node of orgNodes.filter((node) => !graph.edges.some((edge) => edge.type === "hierarchy" && edge.target === node.id))) includeOrg(node.id);
  let nodes = graph.nodes.filter((node) => visible.has(node.id) || (showAgents && node.type === "agent" && visible.has(graph.edges.find((edge) => edge.target === node.id)?.source)));
  nodes = nodes.filter((node) => {
    const meta = node.metadata || {};
    if (filters.nodeType && node.type === "organization" && meta.node_type !== filters.nodeType) return false;
    if (filters.deploymentStatus && node.type === "agent" && (meta.deployment_status || "Draft") !== filters.deploymentStatus) return false;
    if (filters.riskLevel && node.type === "agent" && ![meta.suggested_risk_level, meta.risk_level, meta.business_criticality].includes(filters.riskLevel)) return false;
    if (filters.hasMetrics) {
      const metric = node.type === "organization" ? meta.metrics?.combined : meta.metrics;
      const has = Boolean(metric?.executions);
      if (filters.hasMetrics === "yes" && !has) return false;
      if (filters.hasMetrics === "no" && has) return false;
    }
    if (queryText && ![node.label, meta.node_code, meta.node_type, meta.owner, meta.agent_type, meta.business_owner].filter(Boolean).join(" ").toLowerCase().includes(queryText)) return false;
    return true;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  return { nodes, edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
}

function layoutGraph(nodes, edges, layout) {
  if (layout.includes("funnel")) return layoutFunnelGraph(nodes, edges);
  const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
  const incoming = new Map();
  const children = new Map();
  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    if (!children.has(edge.source)) children.set(edge.source, []);
    children.get(edge.source).push(edge.target);
  }
  const roots = nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  const levels = new Map();
  const queue = roots.map((id) => [id, 0]);
  while (queue.length) {
    const [id, level] = queue.shift();
    if (levels.has(id) && levels.get(id) <= level) continue;
    levels.set(id, level);
    for (const child of children.get(id) || []) queue.push([child, level + 1]);
  }
  const grouped = new Map();
  for (const node of nodes) {
    const level = layout.includes("grouped by node type") ? String(node.metadata?.node_type || node.type) : String(levels.get(node.id) || 0);
    if (!grouped.has(level)) grouped.set(level, []);
    grouped.get(level).push(node.id);
  }
  const horizontal = layout.includes("horizontal");
  const compact = layout.includes("compact");
  const xGap = compact ? 250 : 300;
  const yGap = compact ? 150 : 190;
  const positioned = [];
  [...grouped.entries()].forEach(([level, ids], levelIndex) => {
    ids.forEach((id, index) => {
      const node = byId.get(id);
      const depth = Number.isNaN(Number(level)) ? levelIndex : Number(level);
      node.x = horizontal ? index * xGap + 40 : depth * xGap + 40;
      node.y = horizontal ? depth * yGap + 40 : index * yGap + 40;
      positioned.push(node);
    });
  });
  return { nodes, edges, positioned, bounds: { width: Math.max(1200, ...positioned.map((node) => node.x + 300)), height: Math.max(720, ...positioned.map((node) => node.y + 180)) } };
}

function layoutFunnelGraph(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
  const incoming = new Map();
  const children = new Map();
  for (const edge of edges) {
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    if (!children.has(edge.source)) children.set(edge.source, []);
    children.get(edge.source).push(edge.target);
  }
  for (const childIds of children.values()) {
    childIds.sort((left, right) => {
      const leftNode = byId.get(left);
      const rightNode = byId.get(right);
      if (leftNode?.type !== rightNode?.type) return leftNode?.type === "organization" ? -1 : 1;
      return String(leftNode?.label || "").localeCompare(String(rightNode?.label || ""));
    });
  }
  const roots = nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  let leafCursor = 0;
  const positioned = [];
  const visited = new Set();

  function place(id, depth) {
    const node = byId.get(id);
    if (!node || visited.has(id)) return 0;
    visited.add(id);
    const childIds = children.get(id) || [];
    if (!childIds.length) {
      node.x = leafCursor * 270 + 60;
      leafCursor += 1;
    } else {
      const childXs = childIds.map((childId) => place(childId, depth + 1)).filter((x) => Number.isFinite(x));
      node.x = childXs.length ? childXs.reduce((sum, x) => sum + x, 0) / childXs.length : leafCursor * 270 + 60;
    }
    node.y = depth * 180 + 40;
    positioned.push(node);
    return node.x;
  }

  roots.forEach((rootId) => place(rootId, 0));
  nodes.forEach((node) => {
    if (!visited.has(node.id)) place(node.id, 0);
  });
  const minX = Math.min(0, ...positioned.map((node) => node.x));
  if (minX < 40) positioned.forEach((node) => (node.x += 40 - minX));
  return {
    nodes,
    edges,
    positioned,
    bounds: {
      width: Math.max(1200, ...positioned.map((node) => node.x + 300)),
      height: Math.max(720, ...positioned.map((node) => node.y + 180)),
    },
  };
}

function graphMetric(node, kpi, aggregation) {
  const metrics = node.type === "organization" ? node.metadata?.metrics?.[aggregation] || {} : node.metadata?.metrics || {};
  return metrics[kpi] || 0;
}

function kpiLabel(kpi) {
  return GRAPH_KPIS.find(([id]) => id === kpi)?.[1] || kpi;
}

function formatGraphMetric(kpi, value) {
  if (kpi === "cost") return formatCost(value);
  if (kpi.includes("rate")) return formatPercent(value);
  if (kpi.includes("latency") || kpi.includes("duration")) return formatDuration(value);
  return formatNumber(value);
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function objectRows(object = {}) {
  return Object.entries(object).map(([label, value]) => ({ label, value }));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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

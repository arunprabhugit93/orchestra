import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "./api/client";

const STORE_KEY = "agent-monitor.ai-agent-onboarding.v1";

const CRITICALITY = ["Low", "Medium", "High", "Critical"];
const YES_NO_UNKNOWN = ["Yes", "No", "Unknown"];
const DATA_CLASSIFICATIONS = ["Public", "Internal", "Confidential", "Restricted", "Highly Confidential"];
const STATUS_FLOW = ["Draft", "Submitted", "In Qualification", "More Information Required", "Approved for Design", "Rejected", "On Hold"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const AI_CAPABILITIES = ["Knowledge Assistant", "Workflow Agent", "Decision Support Agent", "Monitoring Agent", "Document Processing Agent", "Reporting Agent", "Customer Service Agent", "Compliance Review Agent", "Data Analysis Agent", "Transaction Execution Agent", "Multi-Agent Workflow"];
const AUTONOMY_LEVELS = ["Assist Only", "Recommend Only", "Draft for Human Review", "Execute with Approval", "Execute Autonomously"];
const OUTPUTS = ["Answer", "Summary", "Recommendation", "Draft Document", "Report", "Alert", "System Update", "Workflow Action"];
const REQUIRED_ACCESS = ["Read Only", "Write", "Read and Write", "Execute", "Unknown"];
const FREQUENCIES = ["Ad-hoc", "Daily", "Weekly", "Monthly", "Quarterly", "Event-driven"];

const DEFINITIONS = {
  departments: {
    title: "Departments",
    subtitle: "Configure organization nodes and business areas used for AI request impact mapping.",
    singular: "Department",
    filters: [
      ["departmentType", "Type"],
      ["businessCriticality", "Criticality"],
    ],
    columns: [
      ["name", "Name"],
      ["departmentType", "Type"],
      ["parentDepartmentId", "Parent Department", "department"],
      ["ownerName", "Owner"],
      ["businessCriticality", "Business Criticality", "risk"],
      ["operatingModel", "Operating Model"],
      ["defaultDataSensitivity", "Default Data Sensitivity", "risk"],
      ["status", "Status", "status"],
    ],
    fields: [
      ["name", "Name", "text"],
      ["code", "Code", "text"],
      ["description", "Description", "textarea"],
      ["parentDepartmentId", "Parent Department", "department"],
      ["departmentType", "Department Type", "select", ["Corporate", "Business Unit", "Division", "Department", "Sub-Unit", "Regional Office", "Shared Service"]],
      ["ownerName", "Owner Name", "text"],
      ["ownerEmail", "Owner Email", "email"],
      ["businessCriticality", "Business Criticality", "select", CRITICALITY],
      ["operatingModel", "Operating Model", "select", ["Internal Only", "Customer Facing", "Partner Facing", "Vendor Facing", "Mixed"]],
      ["primaryLocation", "Primary Location", "text"],
      ["affectedUserGroups", "Affected User Groups", "userGroups"],
      ["primarySystems", "Primary Systems", "systems"],
      ["defaultDataSensitivity", "Default Data Sensitivity", "select", DATA_CLASSIFICATIONS],
      ["approvalOwner", "Approval Owner", "text"],
      ["status", "Status", "select", ["Active", "Inactive"]],
    ],
  },
  systems: {
    title: "Systems",
    subtitle: "Register enterprise systems that AI agents may access, read from, write to, or integrate with.",
    singular: "System",
    filters: [
      ["systemType", "Type"],
      ["hostingModel", "Hosting"],
      ["businessCriticality", "Criticality"],
      ["apiAvailable", "API"],
    ],
    columns: [
      ["name", "System Name"],
      ["systemType", "Type"],
      ["ownerDepartmentId", "Owner Department", "department"],
      ["hostingModel", "Hosting Model"],
      ["businessCriticality", "Criticality", "risk"],
      ["apiAvailable", "API Available"],
      ["writeAccessAllowed", "Write Access"],
      ["externalExposure", "External Exposure"],
      ["status", "Status", "status"],
    ],
    fields: [
      ["name", "Name", "text"],
      ["code", "Code", "text"],
      ["description", "Description", "textarea"],
      ["systemType", "System Type", "select", ["ERP", "CRM", "HRMS", "Finance System", "Procurement System", "Ticketing System", "Document Management", "Email Platform", "Collaboration Platform", "Data Warehouse", "BI Platform", "Database", "Custom Application", "External SaaS", "Legacy System"]],
      ["ownerDepartmentId", "Owner Department", "department"],
      ["technicalOwner", "Technical Owner", "text"],
      ["businessOwner", "Business Owner", "text"],
      ["hostingModel", "Hosting Model", "select", ["On-Premise", "Private Cloud", "Public Cloud", "Hybrid", "SaaS"]],
      ["vendor", "Vendor", "text"],
      ["environment", "Environment", "select", ["Production", "UAT", "Development", "Sandbox"]],
      ["businessCriticality", "Business Criticality", "select", CRITICALITY],
      ["dataClassification", "Data Classification", "select", DATA_CLASSIFICATIONS],
      ["containsPII", "Contains PII", "select", YES_NO_UNKNOWN],
      ["apiAvailable", "API Available", "select", YES_NO_UNKNOWN],
      ["authenticationType", "Authentication Type", "select", ["OAuth", "SSO", "API Key", "Basic Auth", "Certificate", "Database Credential", "Manual", "Unknown"]],
      ["integrationConstraints", "Integration Constraints", "textarea"],
      ["writeAccessAllowed", "Write Access Allowed", "select", ["Yes", "No", "Restricted", "Unknown"]],
      ["externalExposure", "External Exposure", "select", ["Internal Only", "External Customer", "Partner", "Vendor", "Public"]],
      ["complianceScope", "Compliance Scope", "multi", ["PDPA", "GDPR", "ISO 27001", "SOC 2", "Financial Audit", "Internal Policy", "Industry Regulation"]],
      ["status", "Status", "select", ["Active", "Inactive", "Deprecated"]],
    ],
  },
  touchpoints: {
    title: "Integration Touchpoints",
    subtitle: "Define available APIs, files, queues, webhooks, email channels, RPA paths, and human approval touchpoints for each system.",
    singular: "Touchpoint",
    filters: [
      ["linkedSystemId", "System", "system"],
      ["touchpointType", "Type"],
      ["direction", "Direction"],
      ["riskLevel", "Risk"],
    ],
    columns: [
      ["name", "Touchpoint Name"],
      ["linkedSystemId", "Linked System", "system"],
      ["touchpointType", "Type"],
      ["direction", "Direction"],
      ["accessLevel", "Access Level"],
      ["frequency", "Frequency"],
      ["riskLevel", "Risk Level", "risk"],
      ["approvalRequired", "Approval Required"],
      ["status", "Status", "status"],
    ],
    fields: [
      ["name", "Name", "text"],
      ["description", "Description", "textarea"],
      ["linkedSystemId", "Linked System", "system"],
      ["touchpointType", "Touchpoint Type", "select", ["REST API", "SOAP API", "Database View", "Database Write", "File Upload", "File Export", "Batch Job", "Email Ingestion", "Email Sending", "Webhook", "Message Queue", "Event Stream", "RPA / UI Automation", "Manual Approval", "Human Task", "Report Export"]],
      ["direction", "Direction", "select", ["Read", "Write", "Bidirectional"]],
      ["accessLevel", "Access Level", "select", ["Read-only", "Write", "Execute", "Admin", "Approval Required"]],
      ["authenticationRequired", "Authentication Required", "select", YES_NO_UNKNOWN],
      ["authenticationType", "Authentication Type", "select", ["OAuth", "SSO", "API Key", "Certificate", "Database Credential", "Manual Approval", "Unknown"]],
      ["dataObjectsHandled", "Data Objects Handled", "tags"],
      ["frequency", "Frequency", "select", ["Real-time", "Near Real-time", "Scheduled", "Daily", "Weekly", "Monthly", "On-demand"]],
      ["ownerTeam", "Owner Team", "text"],
      ["technicalContact", "Technical Contact", "text"],
      ["riskLevel", "Risk Level", "select", CRITICALITY],
      ["approvalRequired", "Approval Required", "select", ["Yes", "No"]],
      ["restrictions", "Restrictions", "textarea"],
      ["status", "Status", "select", ["Available", "Restricted", "Not Available", "Deprecated"]],
    ],
  },
  dataDomains: {
    title: "Data Domains",
    subtitle: "Classify enterprise data domains used by AI agents for risk, privacy, compliance, and model deployment decisions.",
    singular: "Data Domain",
    filters: [
      ["classification", "Classification"],
      ["containsPII", "PII"],
      ["externalLLMAllowed", "External LLM"],
      ["maskingRequired", "Masking"],
    ],
    columns: [
      ["name", "Data Domain"],
      ["domainType", "Type"],
      ["ownerDepartmentId", "Owner Department", "department"],
      ["classification", "Classification", "risk"],
      ["containsPII", "PII"],
      ["externalLLMAllowed", "External LLM Allowed"],
      ["maskingRequired", "Masking Required"],
      ["auditLoggingRequired", "Audit Required"],
      ["status", "Status", "status"],
    ],
    fields: [
      ["name", "Name", "text"],
      ["description", "Description", "textarea"],
      ["domainType", "Domain Type", "select", ["Customer Data", "Employee Data", "Financial Data", "Operational Data", "Contract Data", "Ticket Data", "Procurement Data", "Sales Data", "Technical Logs", "Security Data", "Public Content", "Knowledge Base", "Document Repository"]],
      ["ownerDepartmentId", "Owner Department", "department"],
      ["dataOwner", "Data Owner", "text"],
      ["classification", "Classification", "select", DATA_CLASSIFICATIONS],
      ["containsPII", "Contains PII", "select", YES_NO_UNKNOWN],
      ["containsFinancialData", "Contains Financial Data", "select", YES_NO_UNKNOWN],
      ["containsCustomerData", "Contains Customer Data", "select", YES_NO_UNKNOWN],
      ["externalLLMAllowed", "External LLM Allowed", "select", ["Yes", "No", "Restricted", "Unknown"]],
      ["maskingRequired", "Masking Required", "select", ["Yes", "No", "Conditional"]],
      ["auditLoggingRequired", "Audit Logging Required", "select", ["Yes", "No"]],
      ["retentionRequirement", "Retention Requirement", "text"],
      ["residencyRequirement", "Residency Requirement", "text"],
      ["complianceScope", "Compliance Scope", "multi", ["PDPA", "GDPR", "ISO 27001", "SOC 2", "Financial Audit", "Internal Policy"]],
      ["status", "Status", "select", ["Active", "Restricted", "Deprecated"]],
    ],
  },
  userGroups: {
    title: "User Groups",
    subtitle: "Define internal and external user groups that may use or be affected by AI agents.",
    singular: "User Group",
    filters: [
      ["groupType", "Type"],
      ["externalFacing", "External"],
      ["impactType", "Impact"],
    ],
    columns: [
      ["name", "User Group"],
      ["groupType", "Type"],
      ["linkedDepartmentId", "Linked Department", "department"],
      ["estimatedUserCount", "Estimated Users"],
      ["accessLevel", "Access Level"],
      ["impactType", "Impact Type"],
      ["externalFacing", "External Facing"],
      ["trainingRequired", "Training Required"],
      ["status", "Status", "status"],
    ],
    fields: [
      ["name", "Name", "text"],
      ["description", "Description", "textarea"],
      ["groupType", "Group Type", "select", ["Internal Employee", "External Customer", "Partner", "Vendor", "Administrator", "Approver", "Reviewer", "Executive", "Support Agent"]],
      ["linkedDepartmentId", "Linked Department", "department"],
      ["estimatedUserCount", "Estimated User Count", "number"],
      ["accessLevel", "Access Level", "select", ["Viewer", "Contributor", "Approver", "Administrator", "External User"]],
      ["impactType", "Impact Type", "select", ["Productivity Improvement", "Decision Support", "Customer Experience", "Compliance Review", "Operational Execution", "Reporting", "Risk Monitoring"]],
      ["trainingRequired", "Training Required", "select", ["Yes", "No", "Minimal"]],
      ["externalFacing", "External Facing", "select", ["Yes", "No"]],
      ["status", "Status", "select", ["Active", "Inactive"]],
    ],
  },
  processAreas: {
    title: "Process Areas",
    subtitle: "Configure business process areas used to classify AI requests and automation opportunities.",
    singular: "Process Area",
    filters: [
      ["processCategory", "Category"],
      ["processCriticality", "Criticality"],
      ["automationPotential", "Automation"],
    ],
    columns: [
      ["name", "Process Area"],
      ["processCategory", "Category"],
      ["ownerDepartmentId", "Owner Department", "department"],
      ["processOwner", "Process Owner"],
      ["processCriticality", "Criticality", "risk"],
      ["automationPotential", "Automation Potential"],
      ["currentMaturity", "Current Maturity"],
      ["status", "Status", "status"],
    ],
    fields: [
      ["name", "Name", "text"],
      ["description", "Description", "textarea"],
      ["processCategory", "Process Category", "select", ["Finance", "HR", "Procurement", "IT Operations", "Customer Service", "Sales", "Compliance", "Legal", "Reporting", "Document Processing", "Knowledge Management", "Case Management", "Risk Management"]],
      ["ownerDepartmentId", "Owner Department", "department"],
      ["processOwner", "Process Owner", "text"],
      ["processCriticality", "Process Criticality", "select", CRITICALITY],
      ["automationPotential", "Automation Potential", "select", ["Low", "Medium", "High"]],
      ["currentMaturity", "Current Maturity", "select", ["Manual", "Semi-Automated", "System-Based", "Automated"]],
      ["status", "Status", "select", ["Active", "Inactive"]],
    ],
  },
};

const EMPTY_REQUEST = {
  id: "",
  requestNumber: "",
  source: "Manual",
  title: "",
  description: "",
  requestOwnerName: "",
  requestOwnerEmail: "",
  priority: "Medium",
  targetTimeline: "",
  businessProblem: "",
  desiredOutcome: "",
  currentProcessDescription: "",
  expectedBusinessImpact: "",
  expectedFrequency: "Monthly",
  primaryDepartmentId: "",
  affectedDepartmentIds: [],
  processAreaIds: [],
  userGroupIds: [],
  requestedAICapability: "",
  agentAutonomyLevel: "",
  expectedOutput: [],
  systemsInvolvedIds: [],
  noSystemIdentified: false,
  touchpointIds: [],
  dataDomainIds: [],
  dataDomainUnknown: false,
  requiredAccess: "Unknown",
  realTimeRequired: "Unknown",
  externalUsersImpacted: "Unknown",
  customerFacing: "Unknown",
  sensitiveDataExpected: "Unknown",
  humanApprovalRequired: "Unknown",
  attachments: "",
  notes: "",
  status: "Draft",
  createdAt: "",
  updatedAt: "",
  submittedAt: "",
  activity: [],
};

export function AiAgentOnboardingModule({ section, onSection, selectedId, onSelect }) {
  const [state, setState] = useState(loadState);
  const [draft, setDraft] = useState(() => ({ ...EMPTY_REQUEST }));
  const [detailId, setDetailId] = useState(selectedId || state.requests[0]?.id || "");

  useEffect(() => localStorage.setItem(STORE_KEY, JSON.stringify(state)), [state]);
  useEffect(() => {
    if (selectedId) setDetailId(selectedId);
  }, [selectedId]);

  const selectedRequest = state.requests.find((request) => request.id === detailId) || state.requests[0] || null;
  const detailRequest = section === "detail" ? selectedRequest : null;

  function saveRegistry(type, item) {
    setState((current) => {
      const now = new Date().toISOString();
      const next = { ...item, id: item.id || makeId(type), createdAt: item.createdAt || now, updatedAt: now };
      return { ...current, [type]: item.id ? current[type].map((row) => (row.id === item.id ? next : row)) : [next, ...current[type]] };
    });
  }

  function removeRegistry(type, id) {
    setState((current) => ({ ...current, [type]: current[type].map((row) => (row.id === id ? { ...row, status: row.status === "Inactive" ? "Active" : "Inactive", updatedAt: new Date().toISOString() } : row)) }));
  }

  function saveRequest(nextRequest, status) {
    const validation = validateRequest(nextRequest, status);
    if (validation.length) return validation;
    const now = new Date().toISOString();
    const existing = state.requests.find((request) => request.id === nextRequest.id);
    const request = {
      ...nextRequest,
      id: nextRequest.id || makeId("request"),
      requestNumber: nextRequest.requestNumber || nextRequestNumber(state.requests),
      status,
      impactProfile: buildImpactProfile(nextRequest, state),
      createdAt: nextRequest.createdAt || now,
      updatedAt: now,
      submittedAt: status === "Submitted" && !nextRequest.submittedAt ? now : nextRequest.submittedAt,
      activity: [...(nextRequest.activity || []), { status, at: now, note: existing ? `Updated as ${status}` : `Created as ${status}` }],
    };
    setState((current) => ({
      ...current,
      requests: existing ? current.requests.map((row) => (row.id === request.id ? request : row)) : [request, ...current.requests],
    }));
    setDraft({ ...EMPTY_REQUEST });
    setDetailId(request.id);
    onSelect?.(request.id);
    onSection?.(status === "Draft" ? "requests" : "qualification");
    return [];
  }

  function changeRequestStatus(request, status) {
    saveRequest({ ...request }, status);
  }

  if (section === "new") {
    return <RequestForm draft={draft} setDraft={setDraft} state={state} onSave={saveRequest} onCancel={() => onSection("requests")} />;
  }
  if (section === "requests") {
    return <RequestsPage state={state} onNew={() => onSection("new")} onOpen={(id) => { setDetailId(id); onSelect?.(id); onSection("detail"); }} />;
  }
  if (section === "qualification") {
    return <QualificationQueue state={state} onOpen={(id) => { setDetailId(id); onSelect?.(id); onSection("detail"); }} onStatus={changeRequestStatus} />;
  }
  if (detailRequest) {
    return <RequestDetail request={detailRequest} state={state} onEdit={() => { setDraft(detailRequest); onSection("new"); }} onStatus={changeRequestStatus} />;
  }
  if (DEFINITIONS[section]) {
    return <RegistryPage type={section} definition={DEFINITIONS[section]} state={state} onSave={saveRegistry} onDeactivate={removeRegistry} />;
  }
  return <OperationalSummary state={state} onNew={() => onSection("new")} />;
}

function RequestForm({ draft, setDraft, state, onSave, onCancel }) {
  const [errors, setErrors] = useState([]);
  const impact = useMemo(() => buildImpactProfile(draft, state), [draft, state]);
  const availableTouchpoints = state.touchpoints.filter((item) => draft.systemsInvolvedIds.includes(item.linkedSystemId));
  const linkedSystems = state.systems.filter((system) => system.ownerDepartmentId === draft.primaryDepartmentId);
  const linkedUserGroups = state.userGroups.filter((group) => group.linkedDepartmentId === draft.primaryDepartmentId);

  function patch(change) {
    setDraft((current) => {
      const next = { ...current, ...change };
      if (change.systemsInvolvedIds) next.touchpointIds = next.touchpointIds.filter((id) => state.touchpoints.some((tp) => tp.id === id && next.systemsInvolvedIds.includes(tp.linkedSystemId)));
      return next;
    });
  }

  function save(status) {
    const validation = onSave(draft, status);
    setErrors(validation);
  }

  return (
    <section className="aiom-page">
      <PageHeader title="New AI Agent Onboarding Request" subtitle="Capture AI agent requirements, affected business areas, systems, integration touchpoints, and data impact for qualification review.">
        <button className="command-button" type="button" onClick={() => save("Draft")}>Save Draft</button>
        <button className="command-button primary" type="button" onClick={() => save("Submitted")}>Submit to Qualification</button>
      </PageHeader>
      {errors.length > 0 && <div className="settings-error">{errors.join(" ")}</div>}
      <div className="aiom-two-col">
        <div className="aiom-form">
          <FormSection title="Request Basics">
            <Field label="Request Title" value={draft.title} onChange={(value) => patch({ title: value })} />
            <Field label="Request Owner Name" value={draft.requestOwnerName} onChange={(value) => patch({ requestOwnerName: value })} />
            <Field label="Request Owner Email" type="email" value={draft.requestOwnerEmail} onChange={(value) => patch({ requestOwnerEmail: value })} />
            <SelectField label="Priority" value={draft.priority} options={PRIORITIES} onChange={(value) => patch({ priority: value })} />
            <Field label="Target Timeline" value={draft.targetTimeline} onChange={(value) => patch({ targetTimeline: value })} />
            <Field label="Business Problem" wide textarea value={draft.businessProblem} onChange={(value) => patch({ businessProblem: value })} />
            <Field label="Desired Outcome" wide textarea value={draft.desiredOutcome} onChange={(value) => patch({ desiredOutcome: value })} />
            <Field label="Current Process Description" wide textarea value={draft.currentProcessDescription} onChange={(value) => patch({ currentProcessDescription: value })} />
            <Field label="Expected Business Impact" wide textarea value={draft.expectedBusinessImpact} onChange={(value) => patch({ expectedBusinessImpact: value })} />
            <SelectField label="Expected Frequency" value={draft.expectedFrequency} options={FREQUENCIES} onChange={(value) => patch({ expectedFrequency: value })} />
          </FormSection>

          <FormSection title="Affected Organization">
            <SelectField label="Primary Department" value={draft.primaryDepartmentId} options={state.departments} onChange={(value) => patch({ primaryDepartmentId: value })} />
            <MultiSelect label="Affected Departments" value={draft.affectedDepartmentIds} options={state.departments} onChange={(value) => patch({ affectedDepartmentIds: value })} />
            <MultiSelect label="Process Areas" value={draft.processAreaIds} options={state.processAreas} onChange={(value) => patch({ processAreaIds: value })} />
            <MultiSelect label="User Groups Impacted" value={draft.userGroupIds} options={state.userGroups} onChange={(value) => patch({ userGroupIds: value })} />
            {(linkedSystems.length > 0 || linkedUserGroups.length > 0) && <div className="aiom-hint wide">Linked to this department: {[...linkedSystems, ...linkedUserGroups].map((item) => item.name).join(", ")}</div>}
          </FormSection>

          <FormSection title="AI Agent / Use Case Definition">
            <SelectField label="Requested AI Capability" value={draft.requestedAICapability} options={AI_CAPABILITIES} onChange={(value) => patch({ requestedAICapability: value })} />
            <SelectField label="Agent Autonomy Level" value={draft.agentAutonomyLevel} options={AUTONOMY_LEVELS} onChange={(value) => patch({ agentAutonomyLevel: value })} />
            <MultiSelect label="Expected Output" value={draft.expectedOutput} options={OUTPUTS} onChange={(value) => patch({ expectedOutput: value })} />
            <SelectField label="Human Approval Required" value={draft.humanApprovalRequired} options={YES_NO_UNKNOWN} onChange={(value) => patch({ humanApprovalRequired: value })} />
            <SelectField label="Customer Facing" value={draft.customerFacing} options={YES_NO_UNKNOWN} onChange={(value) => patch({ customerFacing: value })} />
            <SelectField label="External Users Impacted" value={draft.externalUsersImpacted} options={YES_NO_UNKNOWN} onChange={(value) => patch({ externalUsersImpacted: value })} />
          </FormSection>

          <FormSection title="Systems and Integration">
            <MultiSelect label="Systems Involved" value={draft.systemsInvolvedIds} options={state.systems} onChange={(value) => patch({ systemsInvolvedIds: value, noSystemIdentified: false })} />
            <label className="check-row wide"><input type="checkbox" checked={draft.noSystemIdentified} onChange={(event) => patch({ noSystemIdentified: event.target.checked, systemsInvolvedIds: event.target.checked ? [] : draft.systemsInvolvedIds })} /> No system identified yet</label>
            <MultiSelect label="Integration Touchpoints" value={draft.touchpointIds} options={availableTouchpoints} onChange={(value) => patch({ touchpointIds: value })} />
            <SelectedTouchpoints touchpoints={state.touchpoints.filter((item) => draft.touchpointIds.includes(item.id))} />
            <SelectField label="Required Access" value={draft.requiredAccess} options={REQUIRED_ACCESS} onChange={(value) => patch({ requiredAccess: value })} />
            <SelectField label="Real-time Required" value={draft.realTimeRequired} options={YES_NO_UNKNOWN} onChange={(value) => patch({ realTimeRequired: value })} />
          </FormSection>

          <FormSection title="Data and Risk">
            <MultiSelect label="Data Domains" value={draft.dataDomainIds} options={state.dataDomains} onChange={(value) => patch({ dataDomainIds: value, dataDomainUnknown: false })} />
            <label className="check-row wide"><input type="checkbox" checked={draft.dataDomainUnknown} onChange={(event) => patch({ dataDomainUnknown: event.target.checked, dataDomainIds: event.target.checked ? [] : draft.dataDomainIds })} /> Data domain unknown</label>
            <SelectedDataDomains domains={state.dataDomains.filter((item) => draft.dataDomainIds.includes(item.id))} />
            <SelectField label="Sensitive Data Expected" value={draft.sensitiveDataExpected} options={YES_NO_UNKNOWN} onChange={(value) => patch({ sensitiveDataExpected: value })} />
            <Field label="Notes / Risk Comments" wide textarea value={draft.notes} onChange={(value) => patch({ notes: value })} />
            <Field label="Attachments" wide textarea value={draft.attachments} onChange={(value) => patch({ attachments: value })} />
          </FormSection>

          <div className="aiom-actions">
            <button className="command-button" type="button" onClick={() => save("Draft")}>Save Draft</button>
            <button className="command-button primary" type="button" onClick={() => save("Submitted")}>Submit to Qualification</button>
            <button className="command-button" type="button" onClick={onCancel}>Cancel</button>
          </div>
        </div>
        <ImpactPreview impact={impact} request={draft} state={state} />
      </div>
    </section>
  );
}

function RegistryPage({ type, definition, state, onSave, onDeactivate }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({});
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const rows = state[type];
  const visible = rows.filter((row) => {
    const text = Object.values(row).flat().join(" ").toLowerCase();
    return text.includes(query.toLowerCase()) && definition.filters.every(([key]) => !filters[key] || String(row[key]) === filters[key]);
  });

  return (
    <section className="aiom-page">
      <PageHeader title={definition.title} subtitle={definition.subtitle}>
        <button className="command-button primary" type="button" onClick={() => setEditing({})}>Add {definition.singular}</button>
      </PageHeader>
      <Toolbar query={query} setQuery={setQuery} filters={definition.filters} rows={rows} values={filters} onChange={setFilters} state={state} />
      <DataTable rows={visible} columns={definition.columns} state={state} onRow={setSelected} actions={(row) => (
        <>
          <button className="mini-button" type="button" onClick={(event) => { event.stopPropagation(); setEditing(row); }}>Edit</button>
          <button className="mini-button" type="button" onClick={(event) => { event.stopPropagation(); onDeactivate(type, row.id); }}>{row.status === "Inactive" ? "Activate" : "Deactivate"}</button>
        </>
      )} />
      {editing && <RegistryDrawer title={`${editing.id ? "Edit" : "Add"} ${definition.singular}`} item={editing} fields={definition.fields} state={state} onClose={() => setEditing(null)} onSave={(item) => { onSave(type, item); setEditing(null); }} />}
      {selected && <DetailDrawer title={selected.name} item={selected} fields={definition.fields} state={state} onClose={() => setSelected(null)} />}
    </section>
  );
}

function RequestsPage({ state, onNew, onOpen }) {
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState("");
  const rows = state.requests.filter((request) => requestText(request, state).includes(query.toLowerCase()))
    .filter((request) => !filters.status || request.status === filters.status)
    .filter((request) => !filters.primaryDepartmentId || request.primaryDepartmentId === filters.primaryDepartmentId)
    .filter((request) => !filters.priority || request.priority === filters.priority)
    .filter((request) => !filters.source || request.source === filters.source)
    .filter((request) => !filters.risk || (request.impactProfile || buildImpactProfile(request, state)).governanceRisk === filters.risk);

  const columns = [
    ["requestNumber", "Request Number"],
    ["title", "Title"],
    ["source", "Source"],
    ["primaryDepartmentId", "Primary Department", "department"],
    ["requestedAICapability", "Requested AI Capability"],
    ["systemsInvolvedIds", "Systems Involved", "systems"],
    ["impactProfile.governanceRisk", "Governance Risk", "risk"],
    ["impactProfile.integrationComplexity", "Integration Complexity", "risk"],
    ["priority", "Priority", "risk"],
    ["status", "Status", "status"],
    ["createdAt", "Created Date", "date"],
    ["requestOwnerName", "Owner"],
  ];

  return (
    <section className="aiom-page">
      <PageHeader title="AI Requests" subtitle="Track manually submitted AI agent onboarding requests and their qualification status.">
        <button className="command-button primary" type="button" onClick={onNew}>New Request</button>
      </PageHeader>
      <RequestFilters state={state} query={query} setQuery={setQuery} filters={filters} setFilters={setFilters} />
      <DataTable rows={rows} columns={columns} state={state} onRow={(row) => onOpen(row.id)} />
    </section>
  );
}

function QualificationQueue({ state, onOpen, onStatus }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({});
  const rows = state.requests
    .filter((request) => ["Submitted", "In Qualification"].includes(request.status))
    .filter((request) => requestText(request, state).includes(query.toLowerCase()))
    .filter((request) => !filters.primaryDepartmentId || request.primaryDepartmentId === filters.primaryDepartmentId)
    .filter((request) => !filters.priority || request.priority === filters.priority)
    .filter((request) => !filters.requestedAICapability || request.requestedAICapability === filters.requestedAICapability)
    .filter((request) => !filters.risk || (request.impactProfile || buildImpactProfile(request, state)).governanceRisk === filters.risk)
    .sort((a, b) => riskRank((b.impactProfile || {}).governanceRisk) - riskRank((a.impactProfile || {}).governanceRisk) || new Date(b.createdAt) - new Date(a.createdAt));
  const columns = [
    ["requestNumber", "Request Number"],
    ["title", "Title"],
    ["primaryDepartmentId", "Department", "department"],
    ["requestedAICapability", "Capability"],
    ["agentAutonomyLevel", "Autonomy"],
    ["systemsInvolvedIds", "Systems", "systems"],
    ["impactProfile.dataSensitivityLevel", "Data Sensitivity", "risk"],
    ["impactProfile.governanceRisk", "Governance Risk", "risk"],
    ["impactProfile.feasibilityRisk", "Feasibility Risk", "risk"],
    ["priority", "Priority", "risk"],
    ["submittedAt", "Submitted Date", "date"],
  ];

  return (
    <section className="aiom-page">
      <PageHeader title="Qualification Queue" subtitle="Review submitted AI agent onboarding requests before architecture and governance design." />
      <RequestFilters state={state} query={query} setQuery={setQuery} filters={filters} setFilters={setFilters} queue />
      <DataTable rows={rows} columns={columns} state={state} onRow={(row) => onOpen(row.id)} actions={(row) => (
        <>
          <button className="mini-button" type="button" onClick={(event) => { event.stopPropagation(); onOpen(row.id); }}>Open Detail</button>
          {[
            ["In Qualification", "Mark In Qualification"],
            ["More Information Required", "Request More Information"],
            ["Approved for Design", "Approve for Design"],
            ["Rejected", "Reject"],
            ["On Hold", "Put On Hold"],
          ].map(([status, label]) => <button key={status} className="mini-button" type="button" onClick={(event) => { event.stopPropagation(); onStatus(row, status); }}>{label}</button>)}
        </>
      )} />
    </section>
  );
}

function RequestDetail({ request, state, onEdit, onStatus }) {
  const [tab, setTab] = useState("Overview");
  const impact = request.impactProfile || buildImpactProfile(request, state);
  const aiComment = useQualificationComments(["Submitted", "In Qualification"].includes(request.status) ? [request] : [], state)[request.id];
  const tabs = ["Overview", "Impact Assessment", "Systems & Integration", "Data & Governance", "Stakeholders", "Activity / History"];
  return (
    <section className="aiom-page">
      <PageHeader title="AI Request Detail" subtitle={`${request.requestNumber} - ${request.title}`}>
        <button className="command-button" type="button" onClick={onEdit}>Edit Request</button>
        {[
          ["Submitted", "Submit to Qualification"],
          ["More Information Required", "Request More Information"],
          ["Approved for Design", "Approve for Design"],
          ["Rejected", "Reject"],
          ["On Hold", "Put On Hold"],
        ].map(([status, label]) => <button key={status} className="command-button" type="button" onClick={() => onStatus(request, status)}>{label}</button>)}
      </PageHeader>
      <div className="aiom-detail-head">
        <h3>{request.title}</h3>
        <Badge value={request.status} kind="status" />
        <Badge value={request.priority} kind="risk" />
        <Badge value={request.source} />
        <span>{request.requestOwnerName || "No owner"}</span>
        <span>{formatDate(request.createdAt)}</span>
      </div>
      {["Submitted", "In Qualification"].includes(request.status) && <AiQualificationCard request={request} comment={aiComment} />}
      <div className="detail-tabs">{tabs.map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      {tab === "Overview" && <KeyValueGrid items={[
        ["Business problem", request.businessProblem],
        ["Desired outcome", request.desiredOutcome],
        ["Current process", request.currentProcessDescription],
        ["Expected business impact", request.expectedBusinessImpact],
        ["Requested AI capability", request.requestedAICapability],
        ["Autonomy level", request.agentAutonomyLevel],
        ["Expected output", request.expectedOutput.join(", ")],
        ["Priority", request.priority],
        ["Timeline", request.targetTimeline],
      ]} />}
      {tab === "Impact Assessment" && <ImpactAssessment impact={impact} />}
      {tab === "Systems & Integration" && <SystemsIntegration request={request} state={state} impact={impact} />}
      {tab === "Data & Governance" && <DataGovernance request={request} state={state} />}
      {tab === "Stakeholders" && <Stakeholders request={request} state={state} />}
      {tab === "Activity / History" && <ActivityHistory request={request} />}
    </section>
  );
}

function OperationalSummary({ state, onNew }) {
  const cards = summaryCards(state);
  return (
    <section className="aiom-page">
      <PageHeader title="AI Agent Onboarding" subtitle="Operational summary for request intake, enterprise mapping, and qualification readiness.">
        <button className="command-button primary" type="button" onClick={onNew}>New Request</button>
      </PageHeader>
      <div className="aiom-metrics">{cards.map(([label, value]) => <div key={label} className="metric"><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="aiom-chart-grid">
        <ListChart title="Requests by Department" rows={groupRequests(state, "department")} />
        <ListChart title="Requests by Capability Type" rows={groupRequests(state, "capability")} />
        <ListChart title="Requests by Status" rows={groupRequests(state, "status")} />
        <ListChart title="Requests by Risk" rows={groupRequests(state, "risk")} />
      </div>
    </section>
  );
}

function useQualificationComments(rows, state) {
  const [comments, setComments] = useState({});
  const context = useMemo(() => buildFullGeminiContext(state), [state]);
  const queueSignature = rows.map((row) => requestFingerprint(row, context)).join("|");

  useEffect(() => {
    let active = true;
    async function loadComments() {
      const queueRows = rows.filter((row) => ["Submitted", "In Qualification"].includes(row.status));
      await Promise.all(queueRows.map(async (request) => {
        const cacheKey = requestFingerprint(request, context);
        if (comments[request.id]?.cacheKey === cacheKey) return;
        const stored = readQualificationCache(request.id, cacheKey);
        if (stored) {
          setComments((current) => ({ ...current, [request.id]: stored }));
          return;
        }
        setComments((current) => ({
          ...current,
          [request.id]: { cacheKey, status: "Loading", source: "Gemini", qualificationComment: "Generating mandatory qualification comments..." },
        }));
        try {
          const result = await fetchJson("/ai-intake/qualification-comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              request: { ...request, impactProfile: request.impactProfile || buildImpactProfile(request, state) },
              enterprise_context: context,
            }),
          });
          if (!active) return;
          const next = { ...result, cacheKey };
          writeQualificationCache(request.id, next);
          setComments((current) => ({ ...current, [request.id]: next }));
        } catch (error) {
          if (!active) return;
          setComments((current) => ({
            ...current,
            [request.id]: {
              cacheKey,
              source: "Backend",
              status: "Error",
              qualificationComment: "AI qualification comments are mandatory but could not be generated.",
              suggestion: "Request More Information",
              reasons: [error.message],
              checksBeforeApproval: ["Confirm backend Gemini configuration and retry before approval."],
              approvalNotes: "Do not approve until the mandatory AI qualification output is available or the reviewer records an exception.",
              attachmentGuidance: "Attach request evidence, process notes, system access details, and data classification confirmation.",
            },
          }));
        }
      }));
    }
    loadComments();
    return () => {
      active = false;
    };
  }, [queueSignature]);

  return comments;
}

function AiQualificationCard({ request, comment, compact }) {
  const item = comment || {
    status: "Loading",
    source: "Gemini",
    qualificationComment: "Generating mandatory qualification comments...",
    reasons: [],
    checksBeforeApproval: [],
  };
  return (
    <article className={`aiom-ai-card ${compact ? "compact" : ""}`}>
      <div className="aiom-ai-card-head">
        <div>
          <span>{request.requestNumber}</span>
          <strong>{request.title}</strong>
        </div>
        <Badge value={item.status || "Generated"} kind={item.status === "Error" || item.status === "Configuration Required" ? "risk" : "status"} />
      </div>
      <p>{item.qualificationComment}</p>
      <div className="aiom-ai-grid">
        <div><span>Suggestion</span><strong>{item.suggestion || "Pending"}</strong></div>
        <div><span>Reasons</span><ul>{(item.reasons || ["Pending generation"]).slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
        <div><span>Check Before Approval</span><ul>{(item.checksBeforeApproval || ["Pending generation"]).slice(0, 5).map((check) => <li key={check}>{check}</li>)}</ul></div>
        <div><span>Critical Empty Fields</span><ul>{(item.criticalEmptyFields || ["Pending generation"]).slice(0, 6).map((field) => <li key={field}>{field}</li>)}</ul></div>
        <div><span>Generalized / Weak Inputs</span><ul>{(item.generalizedInputs || ["Pending generation"]).slice(0, 6).map((field) => <li key={field}>{field}</li>)}</ul></div>
        <div><span>Approval Notes</span><strong>{item.approvalNotes || "Pending generation"}</strong></div>
        <div><span>Attachment Guidance</span><strong>{item.attachmentGuidance || "Pending generation"}</strong></div>
      </div>
    </article>
  );
}

function ImpactPreview({ impact }) {
  return (
    <aside className="aiom-impact">
      <h3>Impact Preview</h3>
      <PreviewBlock title="Organization Impact" items={[
        ["Primary department", impact.affectedDepartments[0] || "Not selected"],
        ["Affected departments", impact.affectedDepartments.length],
        ["User groups impacted", impact.affectedUserGroups.length],
        ["Exposure", impact.externalImpact === "Yes" ? "External" : "Internal"],
      ]} />
      <PreviewBlock title="Systems Impact" items={[
        ["Systems selected", impact.affectedSystems.length],
        ["Highest criticality", impact.systemCriticalityScore],
        ["Write access involved", impact.keyRiskFlags.includes("Write or execute access requires human approval") ? "Yes" : "No"],
        ["Restricted systems", impact.keyRiskFlags.includes("Restricted systems involved") ? "Yes" : "No"],
      ]} />
      <PreviewBlock title="Integration Impact" items={[
        ["Touchpoints selected", impact.affectedTouchpoints.length],
        ["Missing touchpoints", impact.missingInformation.includes("integration touchpoints") ? "Yes" : "No"],
        ["Integration complexity", impact.integrationComplexity],
      ]} />
      <PreviewBlock title="Data Impact" items={[
        ["Highest classification", impact.dataSensitivityLevel],
        ["PII present", flagYes(impact, "PII present")],
        ["Financial data", flagYes(impact, "Financial data present")],
        ["External LLM allowed", impact.privateDeploymentRecommended === "Yes" ? "Restricted" : "Allowed"],
        ["Masking required", flagYes(impact, "Masking required")],
        ["Audit logging", flagYes(impact, "Audit logging required")],
      ]} />
      <PreviewBlock title="AI Operating Pattern" items={[["Pattern", impact.architecturePattern]]} />
      <div className="aiom-preview-block"><strong>Governance Flags</strong>{impact.keyRiskFlags.length ? impact.keyRiskFlags.map((item) => <span key={item}>{item}</span>) : <span>No flags yet</span>}</div>
      <div className="aiom-preview-block"><strong>Missing Information</strong>{impact.missingInformation.length ? impact.missingInformation.map((item) => <span key={item}>{item}</span>) : <span>Required submit fields complete</span>}</div>
    </aside>
  );
}

function ImpactAssessment({ impact }) {
  return (
    <div className="aiom-grid-cards">
      {[
        ["Affected departments", impact.affectedDepartments.join(", ")],
        ["Affected user groups", impact.affectedUserGroups.join(", ")],
        ["Internal impact", impact.internalImpact],
        ["External impact", impact.externalImpact],
        ["System criticality", impact.systemCriticalityScore],
        ["Data sensitivity", impact.dataSensitivityLevel],
        ["Integration complexity", impact.integrationComplexity],
        ["Governance risk", impact.governanceRisk],
        ["Feasibility risk", impact.feasibilityRisk],
        ["Architecture pattern", impact.architecturePattern],
        ["Recommended next step", impact.recommendedNextStep],
        ["Key risk flags", impact.keyRiskFlags.join(", ") || "None"],
        ["Missing information", impact.missingInformation.join(", ") || "None"],
      ].map(([label, value]) => <div key={label} className="summary-card"><span>{label}</span><strong>{value || "Not provided"}</strong></div>)}
    </div>
  );
}

function SystemsIntegration({ request, state, impact }) {
  return <div className="aiom-stack"><DataTable rows={state.systems.filter((item) => request.systemsInvolvedIds.includes(item.id))} columns={DEFINITIONS.systems.columns} state={state} /><DataTable rows={state.touchpoints.filter((item) => request.touchpointIds.includes(item.id))} columns={DEFINITIONS.touchpoints.columns} state={state} /><KeyValueGrid items={[["Required access", request.requiredAccess], ["Real-time requirement", request.realTimeRequired], ["Missing touchpoints", impact.missingInformation.includes("integration touchpoints") ? "Yes" : "No"], ["Restricted touchpoints", impact.keyRiskFlags.includes("Restricted touchpoint requires approval") ? "Yes" : "No"]]} /></div>;
}

function DataGovernance({ request, state }) {
  return <DataTable rows={state.dataDomains.filter((item) => request.dataDomainIds.includes(item.id))} columns={DEFINITIONS.dataDomains.columns} state={state} />;
}

function Stakeholders({ request, state }) {
  const departments = state.departments.filter((item) => [request.primaryDepartmentId, ...request.affectedDepartmentIds].includes(item.id));
  const systems = state.systems.filter((item) => request.systemsInvolvedIds.includes(item.id));
  const domains = state.dataDomains.filter((item) => request.dataDomainIds.includes(item.id));
  const groups = state.userGroups.filter((item) => request.userGroupIds.includes(item.id));
  return <KeyValueGrid items={[
    ["Primary department", nameOf(state, "department", request.primaryDepartmentId)],
    ["Affected departments", departments.map((item) => item.name).join(", ")],
    ["Request owner", `${request.requestOwnerName} ${request.requestOwnerEmail}`],
    ["Department owners", departments.map((item) => item.ownerName).filter(Boolean).join(", ")],
    ["System owners", systems.flatMap((item) => [item.businessOwner, item.technicalOwner]).filter(Boolean).join(", ")],
    ["Data owners", domains.map((item) => item.dataOwner).filter(Boolean).join(", ")],
    ["Affected user groups", groups.map((item) => item.name).join(", ")],
    ["Suggested approvers", [...departments.map((item) => item.approvalOwner || item.ownerName), ...systems.map((item) => item.businessOwner), ...domains.map((item) => item.dataOwner)].filter(Boolean).join(", ")],
  ]} />;
}

function ActivityHistory({ request }) {
  return <div className="aiom-stack">{(request.activity || []).map((item, index) => <div className="activity-row" key={`${item.at}-${index}`}><Badge value={item.status} kind="status" /><span>{formatDate(item.at)}</span><strong>{item.note}</strong></div>)}</div>;
}

function PageHeader({ title, subtitle, children }) {
  return <div className="aiom-header"><div><h3>{title}</h3><p>{subtitle}</p></div><div className="aiom-actions">{children}</div></div>;
}

function FormSection({ title, children }) {
  return <section className="aiom-section"><h4>{title}</h4><div className="aiom-field-grid">{children}</div></section>;
}

function Field({ label, value, onChange, textarea, type = "text", wide }) {
  return <label className={wide ? "wide" : ""}>{label}{textarea ? <textarea value={value || ""} onChange={(event) => onChange(event.target.value)} /> : <input type={type} value={value || ""} onChange={(event) => onChange(event.target.value)} />}</label>;
}

function SelectField({ label, value, options, onChange }) {
  const list = normalizeOptions(options);
  return <label>{label}<select value={value || ""} onChange={(event) => onChange(event.target.value)}><option value="">Select</option>{list.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
}

function MultiSelect({ label, value = [], options, onChange }) {
  const list = normalizeOptions(options);
  return <label className="wide">{label}<div className="aiom-checks">{list.map((item) => <label key={item.value}><input type="checkbox" checked={value.includes(item.value)} onChange={() => onChange(value.includes(item.value) ? value.filter((id) => id !== item.value) : [...value, item.value])} /> {item.label}</label>)}</div></label>;
}

function SelectedTouchpoints({ touchpoints }) {
  if (!touchpoints.length) return null;
  return <div className="selected-meta wide">{touchpoints.map((item) => <span key={item.id}>{item.name}: {item.touchpointType}, {item.direction}, {item.accessLevel}, {item.status}, {item.riskLevel}, approval {item.approvalRequired}</span>)}</div>;
}

function SelectedDataDomains({ domains }) {
  if (!domains.length) return null;
  return <div className="selected-meta wide">{domains.map((item) => <span key={item.id}>{item.name}: {item.classification}, PII {item.containsPII}, external LLM {item.externalLLMAllowed}, masking {item.maskingRequired}, audit {item.auditLoggingRequired}</span>)}</div>;
}

function Toolbar({ query, setQuery, filters, rows, values, onChange, state }) {
  return <div className="aiom-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />{filters.map(([key, label, lookup]) => <select key={key} value={values[key] || ""} onChange={(event) => onChange({ ...values, [key]: event.target.value })}><option value="">{label}</option>{filterOptions(rows, key, lookup, state).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>)}</div>;
}

function RequestFilters({ state, query, setQuery, filters, setFilters, queue }) {
  const items = [
    ["status", "Status", STATUS_FLOW],
    ["primaryDepartmentId", "Department", state.departments],
    ["priority", "Priority", PRIORITIES],
    !queue && ["source", "Source", ["Manual", "Email", "Ticketing", "API"]],
    ["risk", "Risk", CRITICALITY],
    queue && ["requestedAICapability", "Capability", AI_CAPABILITIES],
  ].filter(Boolean);
  return <div className="aiom-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search requests" />{items.map(([key, label, options]) => <select key={key} value={filters[key] || ""} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })}><option value="">{label}</option>{normalizeOptions(options).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>)}</div>;
}

function DataTable({ rows, columns, state, onRow, actions }) {
  return <div className="aiom-table-wrap"><table className="aiom-table"><thead><tr>{columns.map(([, label]) => <th key={label}>{label}</th>)}{actions && <th>Action</th>}</tr></thead><tbody>{rows.map((row) => <tr key={row.id} onClick={() => onRow?.(row)}>{columns.map(([key, , kind]) => <td key={key}>{renderCell(row, key, kind, state)}</td>)}{actions && <td className="table-actions">{actions(row)}</td>}</tr>)}{!rows.length && <tr><td colSpan={columns.length + (actions ? 1 : 0)}>No records found.</td></tr>}</tbody></table></div>;
}

function RegistryDrawer({ title, item, fields, state, onClose, onSave }) {
  const [form, setForm] = useState(item);
  return <div className="drawer-backdrop"><aside className="aiom-drawer"><h3>{title}</h3><div className="aiom-field-grid">{fields.map((field) => <DynamicField key={field[0]} field={field} form={form} setForm={setForm} state={state} />)}</div><div className="aiom-actions"><button className="command-button primary" type="button" onClick={() => onSave(form)}>Save</button><button className="command-button" type="button" onClick={onClose}>Cancel</button></div></aside></div>;
}

function DetailDrawer({ title, item, fields, state, onClose }) {
  return <div className="drawer-backdrop"><aside className="aiom-drawer"><h3>{title}</h3><KeyValueGrid items={fields.map(([key, label, type]) => [label, displayValue(item[key], type, state)])} /><div className="aiom-actions"><button className="command-button" type="button" onClick={onClose}>Close</button></div></aside></div>;
}

function DynamicField({ field, form, setForm, state }) {
  const [key, label, type, options] = field;
  const set = (value) => setForm((current) => ({ ...current, [key]: value }));
  if (type === "textarea") return <Field label={label} textarea wide value={form[key]} onChange={set} />;
  if (type === "select") return <SelectField label={label} value={form[key]} options={options} onChange={set} />;
  if (type === "department") return <SelectField label={label} value={form[key]} options={state.departments} onChange={set} />;
  if (type === "system") return <SelectField label={label} value={form[key]} options={state.systems} onChange={set} />;
  if (type === "systems") return <MultiSelect label={label} value={form[key] || []} options={state.systems} onChange={set} />;
  if (type === "userGroups") return <MultiSelect label={label} value={form[key] || []} options={state.userGroups} onChange={set} />;
  if (type === "multi") return <MultiSelect label={label} value={form[key] || []} options={options} onChange={set} />;
  if (type === "tags") return <Field label={label} value={(form[key] || []).join(", ")} onChange={(value) => set(value.split(",").map((item) => item.trim()).filter(Boolean))} />;
  return <Field label={label} type={type} value={form[key]} onChange={set} />;
}

function KeyValueGrid({ items }) {
  return <div className="aiom-kv">{items.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || "Not provided"}</strong></div>)}</div>;
}

function PreviewBlock({ title, items }) {
  return <div className="aiom-preview-block"><strong>{title}</strong>{items.map(([label, value]) => <span key={label}>{label}: <b>{value}</b></span>)}</div>;
}

function ListChart({ title, rows }) {
  return <div className="aiom-list-chart"><h4>{title}</h4>{rows.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>;
}

function Badge({ value, kind }) {
  return <span className={`aiom-badge ${kind || ""} ${String(value || "").toLowerCase().replaceAll(" ", "-")}`}>{value || "None"}</span>;
}

function buildImpactProfile(request, state) {
  const departments = state.departments.filter((item) => [request.primaryDepartmentId, ...(request.affectedDepartmentIds || [])].includes(item.id));
  const systems = state.systems.filter((item) => (request.systemsInvolvedIds || []).includes(item.id));
  const touchpoints = state.touchpoints.filter((item) => (request.touchpointIds || []).includes(item.id));
  const domains = state.dataDomains.filter((item) => (request.dataDomainIds || []).includes(item.id));
  const groups = state.userGroups.filter((item) => (request.userGroupIds || []).includes(item.id));
  const flags = [];
  const missing = [];
  let governance = "Low";
  let feasibility = "Low";
  let complexity = touchpoints.length > 2 || systems.length > 2 ? "Medium" : "Low";
  let privateDeployment = "To Be Assessed";
  let approval = request.humanApprovalRequired === "Yes" ? "Yes" : "No";

  if (!request.businessProblem) missing.push("business problem");
  if (!request.desiredOutcome) missing.push("desired outcome");
  if (!request.primaryDepartmentId) missing.push("primary department");
  if (!request.systemsInvolvedIds?.length && !request.noSystemIdentified) missing.push("systems involved");
  if (!request.dataDomainIds?.length && !request.dataDomainUnknown) missing.push("data domains");
  if (!request.agentAutonomyLevel) missing.push("autonomy level");
  if (request.noSystemIdentified) missing.push("system not identified yet");
  if (request.dataDomainUnknown) missing.push("data domain unknown");

  const highestSystem = highest(systems.map((item) => item.businessCriticality));
  const highestData = highest(domains.map((item) => item.classification), DATA_CLASSIFICATIONS);
  if (["Restricted", "Highly Confidential"].includes(highestData)) {
    governance = bump(governance, 2);
    privateDeployment = "Yes";
    flags.push("Audit logging required");
  }
  if (domains.some((item) => item.containsPII === "Yes")) {
    governance = bump(governance);
    flags.push("PII present", "Masking required", "Data governance review required");
  }
  if (domains.some((item) => item.containsFinancialData === "Yes")) flags.push("Financial data present");
  if (systems.some((item) => item.businessCriticality === "Critical")) {
    flags.push("Architecture review required");
  }
  if (systems.some((item) => item.writeAccessAllowed === "Restricted")) flags.push("Restricted systems involved");
  if (["Write", "Read and Write", "Execute"].includes(request.requiredAccess)) {
    approval = "Yes";
    governance = bump(governance);
    flags.push("Write or execute access requires human approval");
  }
  if (request.agentAutonomyLevel === "Execute Autonomously") {
    governance = governance === "High" ? "Critical" : "High";
    approval = "Yes";
    flags.push("Architecture review required");
  }
  if (request.customerFacing === "Yes" || request.externalUsersImpacted === "Yes" || groups.some((item) => item.externalFacing === "Yes")) {
    governance = bump(governance);
    flags.push("External exposure detected", "Compliance review required");
  }
  if (systems.length && !state.touchpoints.some((item) => request.systemsInvolvedIds.includes(item.linkedSystemId))) {
    feasibility = "High";
    missing.push("integration touchpoints");
    flags.push("Integration feasibility review required");
  }
  if (touchpoints.some((item) => item.status === "Restricted")) {
    complexity = bump(complexity);
    flags.push("Restricted touchpoint requires approval");
  }
  if (departments.length > 1) flags.push("Cross-functional approval recommended");
  if (domains.some((item) => item.externalLLMAllowed === "No")) privateDeployment = "Yes";
  if (domains.some((item) => item.auditLoggingRequired === "Yes")) flags.push("Audit logging required");

  const architecturePattern = patternFor(request, systems);
  const recommendedNextStep = missing.length ? "Request More Information" : flags.includes("Integration feasibility review required") ? "Integration Feasibility Review Required" : flags.includes("Data governance review required") || governanceRank(governance) >= 2 ? "Governance Review Required" : flags.includes("Architecture review required") ? "Architecture Review Required" : "Submit to Qualification";

  return {
    requestId: request.id,
    affectedDepartments: departments.map((item) => item.name),
    affectedSystems: systems.map((item) => item.name),
    affectedTouchpoints: touchpoints.map((item) => item.name),
    affectedDataDomains: domains.map((item) => item.name),
    affectedUserGroups: groups.map((item) => item.name),
    internalImpact: "Yes",
    externalImpact: flags.includes("External exposure detected") ? "Yes" : "No",
    systemCriticalityScore: highestSystem,
    dataSensitivityLevel: highestData,
    integrationComplexity: complexity,
    governanceRisk: governance,
    feasibilityRisk: feasibility,
    humanApprovalRecommended: approval,
    privateDeploymentRecommended: privateDeployment,
    architecturePattern,
    keyRiskFlags: [...new Set(flags)],
    missingInformation: [...new Set(missing)],
    recommendedNextStep,
    generatedAt: new Date().toISOString(),
  };
}

function patternFor(request, systems) {
  if (request.requestedAICapability === "Transaction Execution Agent") return "Transaction Agent with Approval";
  if (request.requestedAICapability === "Knowledge Assistant" && request.requiredAccess === "Read Only") return "RAG Assistant";
  if (request.requestedAICapability === "Monitoring Agent") return "Event-driven Monitoring Agent";
  if (request.requestedAICapability === "Multi-Agent Workflow") return "Multi-agent Orchestration";
  if (request.agentAutonomyLevel === "Assist Only") return systems.length > 2 ? "RAG Assistant" : "Simple Copilot";
  if (request.agentAutonomyLevel === "Execute with Approval") return "Human-in-the-loop Workflow Agent";
  return request.requestedAICapability ? "Human-in-the-loop Workflow Agent" : "Not Recommended Yet";
}

function validateRequest(request, status) {
  if (status === "Draft") return !request.title.trim() ? ["Request Title is required to save a draft."] : [];
  return [
    !request.title.trim() && "title",
    !request.requestOwnerName.trim() && "request owner",
    !request.businessProblem.trim() && "business problem",
    !request.desiredOutcome.trim() && "desired outcome",
    !request.primaryDepartmentId && "primary department",
    !request.requestedAICapability && "requested AI capability",
    !request.agentAutonomyLevel && "autonomy level",
    !request.systemsInvolvedIds.length && !request.noSystemIdentified && "at least one system or No system identified yet",
    !request.dataDomainIds.length && !request.dataDomainUnknown && "at least one data domain or Data domain unknown",
  ].filter(Boolean).map((item) => `Missing ${item}.`);
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    if (stored?.departments?.length) return stored;
  } catch {
    // Fall through to seed data.
  }
  return seedState();
}

function seedState() {
  const now = new Date().toISOString();
  const departments = [
    dept("dep-fin", "Finance / FP&A", "FIN", "Department", "Asha Menon", "High", "Internal Only", "Confidential"),
    dept("dep-hr", "HR Operations", "HR", "Department", "Daniel Lim", "High", "Internal Only", "Highly Confidential"),
    dept("dep-it", "IT Operations", "IT", "Shared Service", "Priya Nair", "Critical", "Mixed", "Internal"),
    dept("dep-proc", "Procurement", "PROC", "Department", "Mohan Rao", "Medium", "Vendor Facing", "Confidential"),
    dept("dep-cs", "Customer Service", "CS", "Department", "Rachel Tan", "High", "Customer Facing", "Confidential"),
    dept("dep-legal", "Legal & Compliance", "LGL", "Department", "Nur Aina", "Critical", "Internal Only", "Restricted"),
  ].map((item) => ({ ...item, createdAt: now, updatedAt: now }));
  const systems = [
    sys("sys-sap", "SAP ERP", "ERP", "dep-fin", "Critical", "Confidential", "Yes", "Restricted", "Internal Only"),
    sys("sys-snow", "ServiceNow", "Ticketing System", "dep-it", "High", "Internal", "Yes", "Yes", "Internal Only"),
    sys("sys-sp", "SharePoint", "Document Management", "dep-it", "Medium", "Confidential", "Yes", "Restricted", "Internal Only"),
    sys("sys-teams", "Microsoft Teams", "Collaboration Platform", "dep-it", "Medium", "Internal", "Yes", "Yes", "Internal Only"),
    sys("sys-pbi", "Power BI", "BI Platform", "dep-fin", "High", "Confidential", "Yes", "Restricted", "Internal Only"),
  ].map((item) => ({ ...item, createdAt: now, updatedAt: now }));
  const touchpoints = [
    tp("tp-sap-budget", "SAP Budget Read API", "sys-sap", "REST API", "Read", "Read-only", "Medium", "Available", "No"),
    tp("tp-sap-pay", "SAP Payment Update API", "sys-sap", "REST API", "Write", "Approval Required", "Critical", "Restricted", "Yes"),
    tp("tp-snow", "ServiceNow Ticket Read/Update API", "sys-snow", "REST API", "Bidirectional", "Write", "Medium", "Available", "No"),
    tp("tp-sp-read", "SharePoint Document Read", "sys-sp", "File Export", "Read", "Read-only", "Low", "Available", "No"),
    tp("tp-pbi-read", "Power BI Dataset Read", "sys-pbi", "REST API", "Read", "Read-only", "Medium", "Available", "No"),
  ].map((item) => ({ ...item, createdAt: now, updatedAt: now }));
  const dataDomains = [
    domain("data-fin", "Financial Reporting Data", "Financial Data", "dep-fin", "Confidential", "No", "Yes", "No", "Restricted", "Conditional", "Yes"),
    domain("data-emp", "Employee Data", "Employee Data", "dep-hr", "Highly Confidential", "Yes", "No", "No", "No", "Yes", "Yes"),
    domain("data-tickets", "Customer Support Tickets", "Ticket Data", "dep-cs", "Confidential", "Yes", "No", "Yes", "Restricted", "Yes", "Yes"),
    domain("data-kb", "Public Knowledge Base", "Knowledge Base", "dep-it", "Public", "No", "No", "No", "Yes", "No", "No"),
  ].map((item) => ({ ...item, createdAt: now, updatedAt: now }));
  const userGroups = [
    group("grp-fa", "Finance Analysts", "Internal Employee", "dep-fin", 25, "Contributor", "Reporting", "No"),
    group("grp-fm", "Finance Managers", "Approver", "dep-fin", 8, "Approver", "Decision Support", "No"),
    group("grp-hr", "HR Executives", "Internal Employee", "dep-hr", 16, "Contributor", "Productivity Improvement", "No"),
    group("grp-it", "IT Support Agents", "Support Agent", "dep-it", 45, "Contributor", "Operational Execution", "No"),
    group("grp-cs", "Customer Service Agents", "Support Agent", "dep-cs", 80, "Contributor", "Customer Experience", "No"),
    group("grp-ext", "External Customers", "External Customer", "dep-cs", 12000, "External User", "Customer Experience", "Yes"),
  ].map((item) => ({ ...item, createdAt: now, updatedAt: now }));
  const processAreas = [
    process("proc-budget", "Budget Variance Analysis", "Finance", "dep-fin", "Asha Menon", "High", "High", "System-Based"),
    process("proc-onboard", "Employee Onboarding", "HR", "dep-hr", "Daniel Lim", "High", "Medium", "Semi-Automated"),
    process("proc-ticket", "IT Ticket Resolution", "IT Operations", "dep-it", "Priya Nair", "High", "High", "System-Based"),
    process("proc-proc", "Procurement Review", "Procurement", "dep-proc", "Mohan Rao", "Medium", "Medium", "Manual"),
    process("proc-complaint", "Customer Complaint Handling", "Customer Service", "dep-cs", "Rachel Tan", "High", "High", "Semi-Automated"),
    process("proc-contract", "Contract Review", "Legal", "dep-legal", "Nur Aina", "Critical", "Medium", "Manual"),
  ].map((item) => ({ ...item, createdAt: now, updatedAt: now }));
  const state = { departments, systems, touchpoints, dataDomains, userGroups, processAreas, requests: [] };
  state.requests = [
    req("req-1", "AIR-0001", "Automate monthly budget variance commentary", "dep-fin", ["sys-sap", "sys-pbi"], ["tp-sap-budget", "tp-pbi-read"], ["data-fin"], "Reporting Agent", "Draft for Human Review", "Submitted", "Medium", ["grp-fa", "grp-fm"], ["proc-budget"]),
    req("req-2", "AIR-0002", "HR policy assistant for employee queries", "dep-hr", ["sys-sp", "sys-teams"], ["tp-sp-read"], ["data-emp"], "Knowledge Assistant", "Assist Only", "Draft", "High", ["grp-hr"], ["proc-onboard"]),
    req("req-3", "AIR-0003", "ServiceNow ticket triage assistant", "dep-it", ["sys-snow"], ["tp-snow"], ["data-tickets"], "Workflow Agent", "Recommend Only", "In Qualification", "Medium", ["grp-it"], ["proc-ticket"]),
  ].map((request) => ({ ...request, impactProfile: buildImpactProfile(request, state) }));
  return state;
}

function dept(id, name, code, departmentType, ownerName, businessCriticality, operatingModel, defaultDataSensitivity) {
  return { id, name, code, description: "", parentDepartmentId: "", departmentType, ownerName, ownerEmail: "", businessCriticality, operatingModel, primaryLocation: "Malaysia", affectedUserGroups: [], primarySystems: [], defaultDataSensitivity, approvalOwner: ownerName, status: "Active" };
}
function sys(id, name, systemType, ownerDepartmentId, businessCriticality, dataClassification, apiAvailable, writeAccessAllowed, externalExposure) {
  return { id, name, code: id.replace("sys-", "").toUpperCase(), description: "", systemType, ownerDepartmentId, technicalOwner: "Platform Team", businessOwner: "Business Owner", hostingModel: "SaaS", vendor: "", environment: "Production", businessCriticality, dataClassification, containsPII: "Unknown", apiAvailable, authenticationType: "OAuth", integrationConstraints: "", writeAccessAllowed, externalExposure, complianceScope: ["Internal Policy"], status: "Active" };
}
function tp(id, name, linkedSystemId, touchpointType, direction, accessLevel, riskLevel, status, approvalRequired) {
  return { id, name, description: "", linkedSystemId, touchpointType, direction, accessLevel, authenticationRequired: "Yes", authenticationType: "OAuth", dataObjectsHandled: [], frequency: "On-demand", ownerTeam: "Integration Team", technicalContact: "", riskLevel, approvalRequired, restrictions: "", status };
}
function domain(id, name, domainType, ownerDepartmentId, classification, containsPII, containsFinancialData, containsCustomerData, externalLLMAllowed, maskingRequired, auditLoggingRequired) {
  return { id, name, description: "", domainType, ownerDepartmentId, dataOwner: "Data Owner", classification, containsPII, containsFinancialData, containsCustomerData, externalLLMAllowed, maskingRequired, auditLoggingRequired, retentionRequirement: "Per policy", residencyRequirement: "Malaysia", complianceScope: ["Internal Policy"], status: "Active" };
}
function group(id, name, groupType, linkedDepartmentId, estimatedUserCount, accessLevel, impactType, externalFacing) {
  return { id, name, description: "", groupType, linkedDepartmentId, estimatedUserCount, accessLevel, impactType, trainingRequired: "Minimal", externalFacing, status: "Active" };
}
function process(id, name, processCategory, ownerDepartmentId, processOwner, processCriticality, automationPotential, currentMaturity) {
  return { id, name, description: "", processCategory, ownerDepartmentId, processOwner, processCriticality, automationPotential, currentMaturity, status: "Active" };
}
function req(id, requestNumber, title, primaryDepartmentId, systemsInvolvedIds, touchpointIds, dataDomainIds, requestedAICapability, agentAutonomyLevel, status, priority, userGroupIds, processAreaIds) {
  const now = new Date().toISOString();
  return { ...EMPTY_REQUEST, id, requestNumber, title, source: "Manual", requestOwnerName: "Business Owner", requestOwnerEmail: "owner@example.com", priority, businessProblem: title, desiredOutcome: "Reduce manual effort and improve response quality.", currentProcessDescription: "Current process is partially manual.", expectedBusinessImpact: "Improved cycle time and consistency.", primaryDepartmentId, affectedDepartmentIds: [primaryDepartmentId], processAreaIds, userGroupIds, requestedAICapability, agentAutonomyLevel, expectedOutput: ["Report"], systemsInvolvedIds, touchpointIds, dataDomainIds, requiredAccess: requestedAICapability === "Knowledge Assistant" ? "Read Only" : "Read and Write", humanApprovalRequired: "Yes", status, createdAt: now, updatedAt: now, submittedAt: status !== "Draft" ? now : "", activity: [{ status, at: now, note: `Seeded as ${status}` }] };
}

function makeId(prefix) { return `${prefix}-${Math.random().toString(36).slice(2, 9)}`; }
function nextRequestNumber(requests) { return `AIR-${String(requests.length + 1).padStart(4, "0")}`; }
function normalizeOptions(options) { return (options || []).map((item) => typeof item === "string" ? { value: item, label: item } : { value: item.id, label: item.name }); }
function nameOf(state, kind, id) { const map = { department: "departments", system: "systems", userGroups: "userGroups" }; return state[map[kind] || kind]?.find((item) => item.id === id)?.name || ""; }
function displayValue(value, type, state) { if (Array.isArray(value)) return value.map((item) => nameOf(state, type, item) || item).join(", "); return nameOf(state, type, value) || value; }
function filterOptions(rows, key, lookup, state) { return [...new Set(rows.map((row) => row[key]).filter(Boolean))].map((value) => ({ value, label: lookup ? nameOf(state, lookup, value) : value })); }
function renderCell(row, key, kind, state) { const value = key.split(".").reduce((obj, part) => obj?.[part], row); if (kind === "date") return formatDate(value); if (kind === "department") return nameOf(state, "department", value); if (kind === "system") return nameOf(state, "system", value); if (kind === "systems") return (value || []).map((id) => nameOf(state, "system", id)).join(", "); if (kind === "risk" || kind === "status") return <Badge value={value} kind={kind} />; return Array.isArray(value) ? value.join(", ") : value || ""; }
function formatDate(value) { return value ? new Date(value).toLocaleDateString() : ""; }
function highest(values, order = CRITICALITY) { return values.filter(Boolean).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] || "Low"; }
function bump(value, steps = 1) { const index = Math.min(CRITICALITY.length - 1, Math.max(0, CRITICALITY.indexOf(value)) + steps); return CRITICALITY[index]; }
function riskRank(value) { return CRITICALITY.indexOf(value || "Low"); }
function governanceRank(value) { return riskRank(value); }
function flagYes(impact, text) { return impact.keyRiskFlags.includes(text) ? "Yes" : "No"; }
function requestText(request, state) { return [request.requestNumber, request.title, request.status, request.priority, request.requestOwnerName, nameOf(state, "department", request.primaryDepartmentId), request.requestedAICapability].join(" ").toLowerCase(); }
function summaryCards(state) { const requests = state.requests; return [["Total Requests", requests.length], ["Drafts", requests.filter((item) => item.status === "Draft").length], ["Submitted", requests.filter((item) => item.status === "Submitted").length], ["In Qualification", requests.filter((item) => item.status === "In Qualification").length], ["Approved for Design", requests.filter((item) => item.status === "Approved for Design").length], ["High Risk Requests", requests.filter((item) => ["High", "Critical"].includes((item.impactProfile || {}).governanceRisk)).length], ["Requests With Missing Information", requests.filter((item) => (item.impactProfile || {}).missingInformation?.length).length], ["Requests Requiring Integration Review", requests.filter((item) => (item.impactProfile || {}).keyRiskFlags?.includes("Integration feasibility review required")).length]]; }
function groupRequests(state, mode) { const map = {}; state.requests.forEach((request) => { const impact = request.impactProfile || buildImpactProfile(request, state); const key = mode === "department" ? nameOf(state, "department", request.primaryDepartmentId) : mode === "capability" ? request.requestedAICapability : mode === "risk" ? impact.governanceRisk : request.status; map[key || "Unknown"] = (map[key || "Unknown"] || 0) + 1; }); return Object.entries(map); }
function buildFullGeminiContext(state) {
  return {
    departments: state.departments,
    systems: state.systems,
    touchpoints: state.touchpoints,
    dataDomains: state.dataDomains,
    userGroups: state.userGroups,
    processAreas: state.processAreas,
  };
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function requestFingerprint(request, context) {
  return `${request.id}:${request.updatedAt || ""}:${stableStringify({ request, context })}`;
}
function readQualificationCache(requestId, cacheKey) {
  try {
    const cached = JSON.parse(localStorage.getItem(`aiom.qualification.${requestId}`) || "null");
    return cached?.cacheKey === cacheKey ? cached : null;
  } catch {
    return null;
  }
}
function writeQualificationCache(requestId, value) {
  try {
    localStorage.setItem(`aiom.qualification.${requestId}`, JSON.stringify(value));
  } catch {
    // Cache is best-effort.
  }
}

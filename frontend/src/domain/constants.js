export const DATA_VIEWS = [
  { id: "transactions", label: "Transactions" },
  { id: "all", label: "All" },
  { id: "workflow", label: "Workflow" },
  { id: "user_input", label: "User Input" },
  { id: "llm", label: "LLM" },
  { id: "output", label: "Output" },
  { id: "tools", label: "Tools" },
  { id: "errors", label: "Errors" },
];

export const TRACE_FILTERS = [
  { id: "all", label: "All" },
  { id: "workflow", label: "Workflow" },
  { id: "user_input", label: "User Input" },
  { id: "llm", label: "LLM" },
  { id: "output", label: "Output" },
  { id: "tools", label: "Tools" },
  { id: "errors", label: "Errors" },
];

export const EVENT_LABELS = {
  run_start: "Run Started",
  run_end: "Run Completed",
  step_start: "Step Started",
  step_end: "Step Completed",
  llm_call_start: "LLM Call Started",
  llm_call_end: "LLM Call Completed",
  tool_call_start: "Tool Call Started",
  tool_call_end: "Tool Call Completed",
  tool_call_error: "Tool Call Error",
  run_error: "Run Error",
};

export const EMPTY_AGENT_FORM = {
  display_name: "",
  base_url: "https://hipaa.cloud.langfuse.com",
  public_key: "",
  secret_key: "",
};

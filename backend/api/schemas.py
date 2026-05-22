from pydantic import BaseModel, Field


class LangfuseImportRequest(BaseModel):
    limit: int = 100
    from_start_time: str | None = None
    to_start_time: str | None = None
    trace_id: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    environment: str | None = None
    max_pages: int = 5


class AgentNodeMappingRequest(BaseModel):
    node_id: str
    placement_type: str = "Primary"
    status: str = "Active"


class AgentOnboardRequest(BaseModel):
    display_name: str
    provider: str = "langfuse"
    base_url: str
    public_key: str
    secret_key: str
    metadata: dict = Field(default_factory=dict)
    profile: dict = Field(default_factory=dict)
    node_mappings: list[AgentNodeMappingRequest] = Field(default_factory=list)


class AgentUpdateRequest(BaseModel):
    display_name: str | None = None
    provider: str | None = None
    base_url: str | None = None
    public_key: str | None = None
    secret_key: str | None = None
    metadata: dict | None = None
    profile: dict | None = None
    node_mappings: list[AgentNodeMappingRequest] | None = None


class NodeTypeRequest(BaseModel):
    type_name: str
    description: str | None = None
    sort_order: int = 0
    status: str = "Active"


class NodeTypeReorderItem(BaseModel):
    id: str
    sort_order: int


class OrganizationNodeRequest(BaseModel):
    node_name: str
    node_code: str
    parent_id: str | None = None
    node_type_id: str
    description: str | None = None
    owner: str | None = None
    sort_order: int = 0
    status: str = "Active"
    effective_from: str | None = None
    effective_to: str | None = None
    tags: list[str] = Field(default_factory=list)


class MoveNodeRequest(BaseModel):
    new_parent_id: str | None = None


class OrganizationNodeReorderItem(BaseModel):
    id: str
    sort_order: int


class ReorderNodesRequest(BaseModel):
    parent_id: str | None = None
    items: list[OrganizationNodeReorderItem]

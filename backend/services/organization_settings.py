import json
import uuid
from datetime import date
from typing import Any

import asyncpg

from services.db_writer import _pool_or_raise


DEFAULT_TENANT_ID = "default"
DEFAULT_USER = "admin"
ACTIVE_STATUSES = {"Active", "Inactive", "Archived"}
DEFAULT_NODE_TYPES = [
    ("Business Unit", "Top-level business area", 10),
    ("Department", "Department or division", 20),
    ("Sub-Department", "Nested department area", 30),
    ("Function", "Business function", 40),
    ("Process", "Business process", 50),
    ("Activity", "Operational activity", 60),
    ("Use Case Area", "Area used to group future agent use cases", 70),
]


def _new_id() -> str:
    return str(uuid.uuid4())


def _date_value(value: Any) -> Any:
    if not value:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(value)


def _tags_value(tags: list[str] | None) -> str:
    return json.dumps(tags or [])


def _row(row: asyncpg.Record | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("created_at", "updated_at", "archived_at", "effective_from", "effective_to"):
        if data.get(key):
            data[key] = data[key].isoformat()
    if isinstance(data.get("tags"), str):
        data["tags"] = json.loads(data["tags"])
    return data


async def ensure_default_node_types(tenant_id: str = DEFAULT_TENANT_ID) -> None:
    async with _pool_or_raise().acquire() as conn:
        for type_name, description, sort_order in DEFAULT_NODE_TYPES:
            await conn.execute(
                """
                INSERT INTO node_type (id, tenant_id, type_name, description, sort_order, status, created_by, updated_by)
                VALUES ($1,$2,$3,$4,$5,'Active',$6,$6)
                ON CONFLICT (tenant_id, type_name) DO NOTHING
                """,
                _new_id(),
                tenant_id,
                type_name,
                description,
                sort_order,
                DEFAULT_USER,
            )


async def list_node_types(tenant_id: str = DEFAULT_TENANT_ID) -> list[dict[str, Any]]:
    await ensure_default_node_types(tenant_id)
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM node_type WHERE tenant_id=$1 ORDER BY sort_order ASC, type_name ASC",
            tenant_id,
        )
    return [_row(row) for row in rows]


async def create_node_type(data: dict[str, Any], tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> dict[str, Any]:
    await ensure_default_node_types(tenant_id)
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO node_type (id, tenant_id, type_name, description, sort_order, status, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
            RETURNING *
            """,
            _new_id(),
            tenant_id,
            data["type_name"].strip(),
            data.get("description"),
            int(data.get("sort_order") or 0),
            data.get("status") or "Active",
            user,
        )
        await _audit(conn, tenant_id, "node_type", row["id"], "create", user, None, dict(row))
    return _row(row)


async def update_node_type(type_id: str, data: dict[str, Any], tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> dict[str, Any] | None:
    async with _pool_or_raise().acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM node_type WHERE id=$1 AND tenant_id=$2", type_id, tenant_id)
        if not before:
            return None
        row = await conn.fetchrow(
            """
            UPDATE node_type SET
                type_name=$3,
                description=$4,
                sort_order=$5,
                status=$6,
                updated_by=$7,
                updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            type_id,
            tenant_id,
            data.get("type_name", before["type_name"]).strip(),
            data.get("description", before["description"]),
            int(data.get("sort_order") if data.get("sort_order") is not None else before["sort_order"]),
            data.get("status", before["status"]),
            user,
        )
        await _audit(conn, tenant_id, "node_type", type_id, "update", user, dict(before), dict(row))
    return _row(row)


async def reorder_node_types(items: list[dict[str, Any]], tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        for item in items:
            await conn.execute(
                "UPDATE node_type SET sort_order=$3, updated_by=$4, updated_at=NOW() WHERE id=$1 AND tenant_id=$2",
                item["id"],
                tenant_id,
                int(item["sort_order"]),
                user,
            )
    return await list_node_types(tenant_id)


async def list_nodes(tenant_id: str = DEFAULT_TENANT_ID) -> list[dict[str, Any]]:
    await ensure_default_node_types(tenant_id)
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT n.*, t.type_name AS node_type
            FROM organization_node n
            JOIN node_type t ON t.id = n.node_type_id
            WHERE n.tenant_id=$1
            ORDER BY n.level ASC, n.sort_order ASC, n.node_name ASC
            """,
            tenant_id,
        )
    return [_public_node(row) for row in rows]


async def get_hierarchy(tenant_id: str = DEFAULT_TENANT_ID) -> list[dict[str, Any]]:
    nodes = await list_nodes(tenant_id)
    by_id = {node["id"]: {**node, "children": []} for node in nodes}
    roots: list[dict[str, Any]] = []
    for node in by_id.values():
        if node["parent_id"] and node["parent_id"] in by_id:
            by_id[node["parent_id"]]["children"].append(node)
        else:
            roots.append(node)
    _sort_tree(roots)
    return roots


async def get_node(node_id: str, tenant_id: str = DEFAULT_TENANT_ID) -> dict[str, Any] | None:
    async with _pool_or_raise().acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT n.*, t.type_name AS node_type
            FROM organization_node n
            JOIN node_type t ON t.id = n.node_type_id
            WHERE n.id=$1 AND n.tenant_id=$2
            """,
            node_id,
            tenant_id,
        )
    return _public_node(row) if row else None


async def get_children(parent_id: str | None, tenant_id: str = DEFAULT_TENANT_ID) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        if parent_id:
            rows = await conn.fetch(
                """
                SELECT n.*, t.type_name AS node_type FROM organization_node n
                JOIN node_type t ON t.id=n.node_type_id
                WHERE n.tenant_id=$1 AND n.parent_id=$2
                ORDER BY n.sort_order ASC, n.node_name ASC
                """,
                tenant_id,
                parent_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT n.*, t.type_name AS node_type FROM organization_node n
                JOIN node_type t ON t.id=n.node_type_id
                WHERE n.tenant_id=$1 AND n.parent_id IS NULL
                ORDER BY n.sort_order ASC, n.node_name ASC
                """,
                tenant_id,
            )
    return [_public_node(row) for row in rows]


async def search_nodes(query: str = "", status: str | None = None, node_type_id: str | None = None, tenant_id: str = DEFAULT_TENANT_ID) -> list[dict[str, Any]]:
    pattern = f"%{query.strip()}%"
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT n.*, t.type_name AS node_type
            FROM organization_node n
            JOIN node_type t ON t.id=n.node_type_id
            WHERE n.tenant_id=$1
              AND ($2='' OR n.node_name ILIKE $3 OR n.node_code ILIKE $3 OR COALESCE(n.owner,'') ILIKE $3 OR t.type_name ILIKE $3)
              AND ($4::text IS NULL OR n.status=$4)
              AND ($5::text IS NULL OR n.node_type_id=$5)
            ORDER BY n.level ASC, n.sort_order ASC, n.node_name ASC
            """,
            tenant_id,
            query.strip(),
            pattern,
            status,
            node_type_id,
        )
    return [_public_node(row) for row in rows]


async def create_node(data: dict[str, Any], tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> dict[str, Any]:
    await _validate_node_payload(data, tenant_id)
    parent_id = data.get("parent_id")
    async with _pool_or_raise().acquire() as conn:
        level = await _level_for_parent(conn, tenant_id, parent_id)
        row = await conn.fetchrow(
            """
            INSERT INTO organization_node (
                id, tenant_id, node_name, node_code, parent_id, node_type_id, description,
                owner, level, sort_order, status, effective_from, effective_to, tags, created_by, updated_by
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$15)
            RETURNING *
            """,
            _new_id(),
            tenant_id,
            data["node_name"].strip(),
            data["node_code"].strip(),
            parent_id,
            data["node_type_id"],
            data.get("description"),
            data.get("owner"),
            level,
            int(data.get("sort_order") or 0),
            data.get("status") or "Active",
            _date_value(data.get("effective_from")),
            _date_value(data.get("effective_to")),
            _tags_value(data.get("tags")),
            user,
        )
        await _audit(conn, tenant_id, "organization_node", row["id"], "create", user, None, dict(row))
    return await get_node(row["id"], tenant_id)


async def update_node(node_id: str, data: dict[str, Any], tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> dict[str, Any] | None:
    async with _pool_or_raise().acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM organization_node WHERE id=$1 AND tenant_id=$2", node_id, tenant_id)
        if not before:
            return None
    merged = {**dict(before), **{key: value for key, value in data.items() if value is not None}}
    await _validate_node_payload(merged, tenant_id, node_id)
    async with _pool_or_raise().acquire() as conn:
        level = await _level_for_parent(conn, tenant_id, merged.get("parent_id"))
        row = await conn.fetchrow(
            """
            UPDATE organization_node SET
                node_name=$3, node_code=$4, parent_id=$5, node_type_id=$6,
                description=$7, owner=$8, level=$9, sort_order=$10, status=$11,
                effective_from=$12, effective_to=$13, tags=$14::jsonb,
                updated_by=$15, updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            node_id,
            tenant_id,
            merged["node_name"].strip(),
            merged["node_code"].strip(),
            merged.get("parent_id"),
            merged["node_type_id"],
            merged.get("description"),
            merged.get("owner"),
            level,
            int(merged.get("sort_order") or 0),
            merged.get("status") or "Active",
            _date_value(merged.get("effective_from")),
            _date_value(merged.get("effective_to")),
            _tags_value(merged.get("tags") if isinstance(merged.get("tags"), list) else json.loads(merged.get("tags") or "[]")),
            user,
        )
        await _recalculate_descendant_levels(conn, tenant_id, node_id, level)
        await _audit(conn, tenant_id, "organization_node", node_id, "update", user, dict(before), dict(row))
    return await get_node(node_id, tenant_id)


async def archive_node(node_id: str, tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> dict[str, Any] | None:
    async with _pool_or_raise().acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM organization_node WHERE id=$1 AND tenant_id=$2", node_id, tenant_id)
        if not before:
            return None
        child_count = await conn.fetchval("SELECT COUNT(*) FROM organization_node WHERE parent_id=$1 AND tenant_id=$2", node_id, tenant_id)
        row = await conn.fetchrow(
            """
            UPDATE organization_node
            SET status='Archived', archived_by=$3, archived_at=NOW(), updated_by=$3, updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            node_id,
            tenant_id,
            user,
        )
        await _audit(conn, tenant_id, "organization_node", node_id, "archive", user, dict(before), dict(row))
    data = await get_node(node_id, tenant_id)
    data["child_count"] = int(child_count or 0)
    return data


async def move_node(node_id: str, new_parent_id: str | None, tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> dict[str, Any] | None:
    if node_id == new_parent_id:
        raise ValueError("A node cannot be moved under itself.")
    async with _pool_or_raise().acquire() as conn:
        before = await conn.fetchrow("SELECT * FROM organization_node WHERE id=$1 AND tenant_id=$2", node_id, tenant_id)
        if not before:
            return None
        if new_parent_id and await _is_descendant(conn, tenant_id, ancestor_id=node_id, node_id=new_parent_id):
            raise ValueError("Move would create a circular hierarchy.")
        await _assert_unique_name(conn, tenant_id, before["node_name"], new_parent_id, node_id)
        level = await _level_for_parent(conn, tenant_id, new_parent_id)
        row = await conn.fetchrow(
            """
            UPDATE organization_node
            SET parent_id=$3, level=$4, updated_by=$5, updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            node_id,
            tenant_id,
            new_parent_id,
            level,
            user,
        )
        await _recalculate_descendant_levels(conn, tenant_id, node_id, level)
        await _audit(conn, tenant_id, "organization_node", node_id, "move", user, dict(before), dict(row))
    return await get_node(node_id, tenant_id)


async def reorder_nodes(parent_id: str | None, items: list[dict[str, Any]], tenant_id: str = DEFAULT_TENANT_ID, user: str = DEFAULT_USER) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        for item in items:
            await conn.execute(
                """
                UPDATE organization_node
                SET sort_order=$4, updated_by=$5, updated_at=NOW()
                WHERE id=$1 AND tenant_id=$2 AND parent_id IS NOT DISTINCT FROM $3
                """,
                item["id"],
                tenant_id,
                parent_id,
                int(item["sort_order"]),
                user,
            )
    return await get_children(parent_id, tenant_id)


async def get_breadcrumb(node_id: str, tenant_id: str = DEFAULT_TENANT_ID) -> list[dict[str, Any]]:
    async with _pool_or_raise().acquire() as conn:
        rows = await conn.fetch(
            """
            WITH RECURSIVE path AS (
                SELECT id, parent_id, node_name, node_code, 1 AS depth
                FROM organization_node
                WHERE id=$1 AND tenant_id=$2
                UNION ALL
                SELECT n.id, n.parent_id, n.node_name, n.node_code, path.depth + 1
                FROM organization_node n
                JOIN path ON path.parent_id = n.id
                WHERE n.tenant_id=$2
            )
            SELECT id, node_name, node_code FROM path ORDER BY depth DESC
            """,
            node_id,
            tenant_id,
        )
    return [dict(row) for row in rows]


async def check_duplicate_code(node_code: str, node_id: str | None = None, tenant_id: str = DEFAULT_TENANT_ID) -> dict[str, bool]:
    async with _pool_or_raise().acquire() as conn:
        exists = await conn.fetchval(
            """
            SELECT EXISTS (
                SELECT 1 FROM organization_node
                WHERE tenant_id=$1 AND LOWER(node_code)=LOWER($2) AND ($3::text IS NULL OR id<>$3)
            )
            """,
            tenant_id,
            node_code,
            node_id,
        )
    return {"duplicate": bool(exists)}


async def check_duplicate_name(node_name: str, parent_id: str | None = None, node_id: str | None = None, tenant_id: str = DEFAULT_TENANT_ID) -> dict[str, bool]:
    async with _pool_or_raise().acquire() as conn:
        exists = await conn.fetchval(
            """
            SELECT EXISTS (
                SELECT 1 FROM organization_node
                WHERE tenant_id=$1 AND LOWER(node_name)=LOWER($2)
                  AND parent_id IS NOT DISTINCT FROM $3
                  AND ($4::text IS NULL OR id<>$4)
            )
            """,
            tenant_id,
            node_name,
            parent_id,
            node_id,
        )
    return {"duplicate": bool(exists)}


def _public_node(row: asyncpg.Record) -> dict[str, Any]:
    data = _row(row)
    data["nodeName"] = data["node_name"]
    data["nodeCode"] = data["node_code"]
    data["nodeType"] = data["node_type"]
    return data


def _sort_tree(nodes: list[dict[str, Any]]) -> None:
    nodes.sort(key=lambda item: (item.get("sort_order") or 0, item.get("node_name") or ""))
    for node in nodes:
        _sort_tree(node["children"])


async def _validate_node_payload(data: dict[str, Any], tenant_id: str, node_id: str | None = None) -> None:
    if not data.get("node_name"):
        raise ValueError("Node Name is mandatory.")
    if not data.get("node_code"):
        raise ValueError("Node Code is mandatory.")
    if not data.get("node_type_id"):
        raise ValueError("Node Type is mandatory.")
    if data.get("status") not in ACTIVE_STATUSES:
        raise ValueError("Status must be Active, Inactive, or Archived.")
    if data.get("effective_from") and data.get("effective_to") and data["effective_to"] < data["effective_from"]:
        raise ValueError("Effective To cannot be earlier than Effective From.")
    async with _pool_or_raise().acquire() as conn:
        node_type_exists = await conn.fetchval("SELECT EXISTS(SELECT 1 FROM node_type WHERE id=$1 AND tenant_id=$2)", data["node_type_id"], tenant_id)
        if not node_type_exists:
            raise ValueError("Node Type does not exist.")
        if data.get("parent_id"):
            parent_exists = await conn.fetchval("SELECT EXISTS(SELECT 1 FROM organization_node WHERE id=$1 AND tenant_id=$2)", data["parent_id"], tenant_id)
            if not parent_exists:
                raise ValueError("Parent Node does not exist.")
            if node_id and await _is_descendant(conn, tenant_id, ancestor_id=node_id, node_id=data["parent_id"]):
                raise ValueError("Parent Node would create a circular hierarchy.")
        code_duplicate = await check_duplicate_code(data["node_code"], node_id, tenant_id)
        if code_duplicate["duplicate"]:
            raise ValueError("Duplicate node code is not allowed.")
        await _assert_unique_name(conn, tenant_id, data["node_name"], data.get("parent_id"), node_id)


async def _assert_unique_name(conn: asyncpg.Connection, tenant_id: str, node_name: str, parent_id: str | None, node_id: str | None = None) -> None:
    exists = await conn.fetchval(
        """
        SELECT EXISTS (
            SELECT 1 FROM organization_node
            WHERE tenant_id=$1 AND LOWER(node_name)=LOWER($2)
              AND parent_id IS NOT DISTINCT FROM $3
              AND ($4::text IS NULL OR id<>$4)
        )
        """,
        tenant_id,
        node_name,
        parent_id,
        node_id,
    )
    if exists:
        raise ValueError("Duplicate node name under the same parent is not allowed.")


async def _level_for_parent(conn: asyncpg.Connection, tenant_id: str, parent_id: str | None) -> int:
    if not parent_id:
        return 1
    parent_level = await conn.fetchval("SELECT level FROM organization_node WHERE id=$1 AND tenant_id=$2", parent_id, tenant_id)
    if parent_level is None:
        raise ValueError("Parent Node does not exist.")
    return int(parent_level) + 1


async def _is_descendant(conn: asyncpg.Connection, tenant_id: str, ancestor_id: str, node_id: str) -> bool:
    return bool(
        await conn.fetchval(
            """
            WITH RECURSIVE descendants AS (
                SELECT id FROM organization_node WHERE parent_id=$1 AND tenant_id=$3
                UNION ALL
                SELECT child.id FROM organization_node child
                JOIN descendants d ON child.parent_id=d.id
                WHERE child.tenant_id=$3
            )
            SELECT EXISTS(SELECT 1 FROM descendants WHERE id=$2)
            """,
            ancestor_id,
            node_id,
            tenant_id,
        )
    )


async def _recalculate_descendant_levels(conn: asyncpg.Connection, tenant_id: str, node_id: str, level: int) -> None:
    children = await conn.fetch("SELECT id FROM organization_node WHERE parent_id=$1 AND tenant_id=$2", node_id, tenant_id)
    for child in children:
        child_level = level + 1
        await conn.execute("UPDATE organization_node SET level=$3 WHERE id=$1 AND tenant_id=$2", child["id"], tenant_id, child_level)
        await _recalculate_descendant_levels(conn, tenant_id, child["id"], child_level)


async def _audit(
    conn: asyncpg.Connection,
    tenant_id: str,
    entity_type: str,
    entity_id: str,
    action: str,
    changed_by: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> None:
    await conn.execute(
        """
        INSERT INTO org_audit_history (tenant_id, entity_type, entity_id, action, changed_by, before_data, after_data)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
        """,
        tenant_id,
        entity_type,
        entity_id,
        action,
        changed_by,
        json.dumps(before, default=str) if before is not None else None,
        json.dumps(after, default=str) if after is not None else None,
    )

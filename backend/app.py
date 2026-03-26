import base64
import hashlib
import hmac
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


class QueryRequest(BaseModel):
    sql: str


class ValidateQueryResponse(BaseModel):
    valid: bool
    message: str
    columns: list[dict[str, str]]


class EmbedTokenRequest(BaseModel):
    slug: str
    ttl_seconds: int = 3600


class EmbedTokenResponse(BaseModel):
    slug: str
    expires_at: str
    token: str
    embed_url: str
    iframe_html: str


class EmbeddedDashboardResponse(BaseModel):
    dashboard: dict[str, Any]


app = FastAPI(title="Dashboard Builder Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/query")
async def query_metrics(payload: QueryRequest) -> dict[str, Any]:
    host = os.getenv("DATABRICKS_HOST", "")
    token = os.getenv("DATABRICKS_TOKEN", "")
    warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID", "")

    if not host or not token or not warehouse_id:
        return {
            "rows": [
                {
                    "metric_name": "sample_metric",
                    "metric_value": 42,
                    "observed_at": "2026-03-25T00:00:00Z",
                }
            ],
            "columns": [
                {"name": "metric_name", "type": "STRING"},
                {"name": "metric_value", "type": "DOUBLE"},
                {"name": "observed_at", "type": "TIMESTAMP"},
            ],
            "mode": "mock",
        }

    endpoint = f"{host.rstrip('/')}/api/2.0/sql/statements/"
    body = {
        "warehouse_id": warehouse_id,
        "statement": payload.sql,
        "wait_timeout": "20s",
        "disposition": "INLINE",
        "format": "JSON_ARRAY",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=body,
        )

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    data = response.json()
    state = data.get("status", {}).get("state")
    if state != "SUCCEEDED":
        raise HTTPException(status_code=400, detail=f"Statement state is {state}")

    columns = data.get("manifest", {}).get("schema", {}).get("columns", [])
    rows = data.get("result", {}).get("data_array", [])
    column_names = [column.get("name", "column") for column in columns]

    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        normalized_rows.append(
            {
                column_names[index]: value
                for index, value in enumerate(row)
                if index < len(column_names)
            }
        )

    return {
        "rows": normalized_rows,
        "columns": [
            {
                "name": str(column.get("name", "column")),
                "type": str(column.get("type_name", "UNKNOWN")),
            }
            for column in columns
        ],
        "mode": "live",
    }


@app.post("/api/validate-query", response_model=ValidateQueryResponse)
async def validate_query(payload: QueryRequest) -> ValidateQueryResponse:
    host = os.getenv("DATABRICKS_HOST", "")
    token = os.getenv("DATABRICKS_TOKEN", "")
    warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID", "")

    if not payload.sql.strip():
        return ValidateQueryResponse(
            valid=False,
            message="SQL query cannot be empty.",
            columns=[],
        )

    if not host or not token or not warehouse_id:
        return ValidateQueryResponse(
            valid=True,
            message="Mock validation succeeded. Configure Databricks env vars for live validation.",
            columns=[
                {"name": "metric_name", "type": "STRING"},
                {"name": "metric_value", "type": "DOUBLE"},
                {"name": "observed_at", "type": "TIMESTAMP"},
            ],
        )

    endpoint = f"{host.rstrip('/')}/api/2.0/sql/statements/"
    statement = f"SELECT * FROM ({payload.sql}) AS validated_query LIMIT 1"
    body = {
        "warehouse_id": warehouse_id,
        "statement": statement,
        "wait_timeout": "20s",
        "disposition": "INLINE",
        "format": "JSON_ARRAY",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=body,
        )

    if response.status_code >= 400:
        detail = response.text
        return ValidateQueryResponse(
            valid=False,
            message=f"Validation failed: {detail}",
            columns=[],
        )

    data = response.json()
    state = data.get("status", {}).get("state")
    if state != "SUCCEEDED":
        return ValidateQueryResponse(
            valid=False,
            message=f"Validation failed with statement state: {state}",
            columns=[],
        )

    columns = data.get("manifest", {}).get("schema", {}).get("columns", [])
    normalized_columns = [
        {
            "name": str(column.get("name", "column")),
            "type": str(column.get("type_name", "UNKNOWN")),
        }
        for column in columns
    ]

    return ValidateQueryResponse(
        valid=True,
        message="SQL validation succeeded.",
        columns=normalized_columns,
    )


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("utf-8")


def _base64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("utf-8"))


def _sign_embed_payload(payload: dict[str, Any], secret: str) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = _base64url_encode(payload_json)
    signature = hmac.new(secret.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).digest()
    signature_b64 = _base64url_encode(signature)
    return f"{payload_b64}.{signature_b64}"


def verify_embed_token(token: str, secret: str) -> dict[str, Any]:
    try:
        payload_b64, signature_b64 = token.split(".", 1)
    except ValueError as exc:
        raise ValueError("Malformed token") from exc
    expected_signature = hmac.new(
        secret.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256
    ).digest()
    actual_signature = _base64url_decode(signature_b64)
    if not hmac.compare_digest(expected_signature, actual_signature):
        raise ValueError("Invalid token signature")

    payload = json.loads(_base64url_decode(payload_b64).decode("utf-8"))
    if int(payload.get("exp", 0)) <= int(time.time()):
        raise ValueError("Token expired")
    return payload


def _slug_is_safe(slug: str) -> bool:
    return bool(slug) and all(ch.isalnum() or ch in {"-", "_"} for ch in slug)


def _to_saved_dashboard_layout(spec: dict[str, Any]) -> dict[str, Any]:
    metadata = spec.get("metadata", {})
    datasets = spec.get("datasets", [])
    widgets = spec.get("widgets", [])
    layout = spec.get("layout", [])

    return {
        "slug": metadata.get("slug", ""),
        "title": metadata.get("title", "Untitled Dashboard"),
        "updatedAt": metadata.get("updated_at", datetime.now(UTC).isoformat()),
        "datasets": [
            {
                "id": ds.get("id"),
                "name": ds.get("name"),
                "sql": ds.get("sql"),
                "columns": ds.get("columns", []),
                "validationStatus": ds.get("validation_status", "invalid"),
                "validationMessage": ds.get("validation_message") or None,
            }
            for ds in datasets
        ],
        "items": [
            {
                "id": widget.get("id"),
                "type": widget.get("type"),
                "props": {
                    "title": widget.get("props", {}).get("title", ""),
                    "refreshMs": widget.get("props", {}).get("refresh_ms", 30000),
                    "datasetId": widget.get("props", {}).get("dataset_id") or None,
                    "description": widget.get("props", {}).get("description", ""),
                    "textContent": widget.get("props", {}).get("text_content", ""),
                    "showTitle": widget.get("props", {}).get("show_title", True),
                    "showDescription": widget.get("props", {}).get("show_description", False),
                    "coordinates": {
                        "xField": widget.get("props", {}).get("coordinates", {}).get("x_field") or None,
                        "yField": widget.get("props", {}).get("coordinates", {}).get("y_field") or None,
                        "colorField": widget.get("props", {}).get("coordinates", {}).get("color_field") or None,
                        "valueField": widget.get("props", {}).get("coordinates", {}).get("value_field") or None,
                    },
                },
            }
            for widget in widgets
        ],
        "layout": [
            {
                "i": entry.get("i"),
                "x": entry.get("x"),
                "y": entry.get("y"),
                "w": entry.get("w"),
                "h": entry.get("h"),
                "minW": entry.get("min_w"),
                "minH": entry.get("min_h"),
            }
            for entry in layout
        ],
    }


def _load_dashboard_spec_by_slug(slug: str) -> dict[str, Any]:
    if not _slug_is_safe(slug):
        raise HTTPException(status_code=400, detail="Invalid slug")

    base_dir = Path(__file__).resolve().parents[1]
    yaml_path = base_dir / "dashboards" / slug / "dashboard.yaml"
    if not yaml_path.exists():
        raise HTTPException(status_code=404, detail=f"Dashboard spec not found for slug '{slug}'")

    try:
        parsed = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Failed to parse dashboard YAML: {exc}") from exc

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Dashboard YAML root must be an object")

    metadata = parsed.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("slug") != slug:
        raise HTTPException(
            status_code=400,
            detail="Dashboard YAML metadata.slug must match file slug",
        )

    return parsed


@app.post("/api/embed-token", response_model=EmbedTokenResponse)
async def create_embed_token(payload: EmbedTokenRequest) -> EmbedTokenResponse:
    slug = payload.slug.strip()
    if not slug:
        raise HTTPException(status_code=400, detail="slug is required")

    ttl_seconds = max(60, min(payload.ttl_seconds, 86400))
    now = int(time.time())
    expires_at = now + ttl_seconds

    secret = os.getenv("EMBED_TOKEN_SECRET", "dev-embed-secret")
    embed_host = os.getenv("EMBED_BASE_URL", "http://localhost:8000").rstrip("/")

    token = _sign_embed_payload(
        {
            "slug": slug,
            "iat": now,
            "exp": expires_at,
        },
        secret,
    )

    embed_url = f"{embed_host}/embed/{slug}?token={token}"
    iframe_html = (
        f'<iframe src="{embed_url}" width="100%" height="720" '
        'style="border:0;" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>'
    )

    return EmbedTokenResponse(
        slug=slug,
        expires_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at)),
        token=token,
        embed_url=embed_url,
        iframe_html=iframe_html,
    )


@app.get("/api/embed-token/verify")
async def verify_embed_token_endpoint(token: str) -> dict[str, Any]:
    secret = os.getenv("EMBED_TOKEN_SECRET", "dev-embed-secret")
    try:
        payload = verify_embed_token(token, secret)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    return {"valid": True, "payload": payload}


@app.get("/api/embed-dashboard/{slug}", response_model=EmbeddedDashboardResponse)
async def get_embed_dashboard(slug: str, token: str) -> EmbeddedDashboardResponse:
    secret = os.getenv("EMBED_TOKEN_SECRET", "dev-embed-secret")
    try:
        payload = verify_embed_token(token, secret)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    token_slug = str(payload.get("slug", ""))
    if token_slug != slug:
        raise HTTPException(status_code=403, detail="Token does not grant access to this slug")

    spec = _load_dashboard_spec_by_slug(slug)
    dashboard = _to_saved_dashboard_layout(spec)
    return EmbeddedDashboardResponse(dashboard=dashboard)

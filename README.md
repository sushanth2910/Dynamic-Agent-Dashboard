# Wren UI Lite

Minimal React UI that sends a question to the Wren AI Service and renders the returned chart.

## Setup

```bash
npm install
npm run dev
```

## Configuration

Create a `.env` file in this folder if you want to override defaults.

```
# Optional. Leave empty to use the Vite proxy (/v1 -> http://localhost:5556)
VITE_API_BASE=

# Required for text-to-SQL (deployment hash from semantics preparation)
VITE_MDL_HASH=

# Optional (default: English)
VITE_LANGUAGE=English
```

The UI calls these AI service endpoints:
- `POST /v1/asks`
- `GET /v1/asks/{query_id}/result`
- `POST /v1/charts`
- `GET /v1/charts/{query_id}`

// JSON requests to the evaluation server (server/server.mjs).
// GET without a body, POST with one.
export async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Request failed (${response.status})`);
  return json;
}

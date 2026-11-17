let token = "";
export async function api<T>(
  path: string,
  method = "GET",
  value?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers:
      method === "GET"
        ? {}
        : { "Content-Type": "application/json", "X-Studio-Token": token },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `请求失败 (${response.status})`);
  if (result.token) token = result.token;
  return result;
}

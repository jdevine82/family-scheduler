// Thin fetch wrapper: JSON in, JSON out, readable errors.
export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error("Can't reach the family calendar. Check the Wi-Fi.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401) throw new Error((data && data.detail) || "Log in to make that change.");
    throw new Error((data && data.detail) || `Something went wrong (${res.status}).`);
  }
  return data;
}
export const get = (url) => api("GET", url);
export const post = (url, body = {}) => api("POST", url, body);
export const patch = (url, body) => api("PATCH", url, body);
export const del = (url) => api("DELETE", url);

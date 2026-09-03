import type { ApiError } from "@shared/types";

const BASE = "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body as ApiError;
    throw new Error(err.error ?? `Request to ${path} failed with ${res.status}`);
  }
  return body as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path, { method: "GET" }),
  post: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  patch: <T,>(path: string, data?: unknown) =>
    request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  // For multipart/form-data uploads (e.g. the QCTO-document instrument
  // intake). Deliberately bypasses `request()`'s JSON Content-Type header -
  // the browser needs to set its own multipart boundary, which it can only
  // do if we don't set Content-Type ourselves.
  postForm: async <T,>(path: string, formData: FormData): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as ApiError;
      throw new Error(err.error ?? `Request to ${path} failed with ${res.status}`);
    }
    return body as T;
  },
};

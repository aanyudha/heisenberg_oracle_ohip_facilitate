import { useQuery } from "@tanstack/react-query";
let csrf = "";
export const setCsrf = (value: string) => {
  csrf = value;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await fetch("/api" + path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(r.status, data.error || "Request failed");
  return data;
}
export function useData<T = any>(key: unknown[], path: string, enabled = true) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => api<T>(path),
    enabled,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
}
export const write = (path: string, body: unknown, method = "POST") =>
  api(path, { method, body: JSON.stringify(body) });
export const time = (value: unknown) =>
  value ? new Date(String(value)).toLocaleString() : "Not synced";

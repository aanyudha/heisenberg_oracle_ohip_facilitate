import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./main";
import { ApiError } from "./api";
import { ErrorBoundary } from "./components";
const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        error instanceof ApiError && error.status < 500 ? false : count < 1,
      staleTime: 10000,
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

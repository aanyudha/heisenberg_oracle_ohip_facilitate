import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Identity } from "@hospitality/contracts";
export function useRealtime(user: Identity) {
  const client = useQueryClient();
  const [state, setState] = useState("Reconnecting");
  const [lastSync, setLastSync] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0,
      sequence = 0,
      lastMessage = Date.now();
    const reconcile = () =>
      client.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== "branding-public",
      });
    function connect() {
      if (stopped) return;
      setState(navigator.onLine ? "Reconnecting" : "Offline");
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?after=${sequence}&csrf=${encodeURIComponent(user.csrf)}`,
      );
      socket.onopen = () => {
        attempt = 0;
        lastMessage = Date.now();
        setState("Connected");
        void reconcile();
      };
      socket.onmessage = (e) => {
        lastMessage = Date.now();
        const event = JSON.parse(e.data);
        sequence = Math.max(sequence, Number(event.seq) || 0);
        if (event.topic === "heartbeat") return;
        setLastSync(new Date().toISOString());
        if (event.topic === "reconcile") {
          void reconcile();
          return;
        }
        if (event.topic === "branding") {
          void client.invalidateQueries({ queryKey: ["me"] });
          return;
        }
        void client.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === "overview" ||
            q.queryKey[0] === "admin" ||
            (q.queryKey.includes(event.propertyId) &&
              (q.queryKey[0] === event.topic ||
                [
                  "integrations",
                  "connections",
                  "ohip-connections",
                  "integration-logs",
                  "retry-jobs",
                  "audit-logs",
                ].includes(String(q.queryKey[0])))),
        });
      };
      socket.onclose = (e) => {
        if (stopped) return;
        setState(navigator.onLine ? "Reconnecting" : "Offline");
        if (e.code === 1008) {
          void client.invalidateQueries({ queryKey: ["me"] });
          return;
        }
        timer = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) +
            Math.random() * 500,
        );
      };
      socket.onerror = () => socket?.close();
    }
    const active = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    const online = () => {
      clearTimeout(timer);
      socket?.close();
    };
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessage > 15000) {
        setState("Offline");
        socket?.close();
      }
    }, 5000);
    document.addEventListener("visibilitychange", active);
    window.addEventListener("online", online);
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      socket?.close();
      document.removeEventListener("visibilitychange", active);
      window.removeEventListener("online", online);
    };
  }, [user.id, user.tenantId, user.csrf, client]);
  return { state, lastSync };
}

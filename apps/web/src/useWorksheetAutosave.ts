import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Worksheet, WorksheetOperation } from "@hospitality/contracts";
import { write } from "./api";
import { moveWorksheet } from "./worksheet-model";
import { browserId as mutationId } from "./browser-id";

export function useWorksheetAutosave(server: Worksheet | undefined) {
  const client = useQueryClient();
  const [sheet, setSheet] = useState(server);
  const [pending, setPending] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [lastChange, setLastChange] = useState<string | null>(null);
  const confirmed = useRef(server),
    view = useRef(server),
    queue = useRef<WorksheetOperation[]>([]),
    inFlight = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    revision = useRef(server?.revision || "0");
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const adopt = useCallback((value: Worksheet | undefined) => {
    view.current = value;
    setSheet(value);
  }, []);
  useEffect(() => {
    if (
      server &&
      !inFlight.current &&
      !queue.current.length &&
      BigInt(server.revision) >= BigInt(revision.current)
    ) {
      confirmed.current = server;
      revision.current = server.revision;
      adopt(server);
    }
  }, [server, adopt]);
  const refresh = useCallback(async () => {
    if (!view.current) return;
    await client.invalidateQueries({
      queryKey: [
        "housekeeping",
        view.current.scope.propertyId,
        view.current.scope.date,
        view.current.scope.shiftId,
        "worksheet",
      ],
    });
  }, [client]);
  const flush = useCallback(async () => {
    if (inFlight.current || !queue.current.length || !view.current) return;
    const ops = queue.current.splice(0),
      base = confirmed.current!,
      scope = view.current.scope;
    inFlight.current = true;
    setSaving(true);
    setPending(queue.current.length > 0);
    try {
      const result = await write(
        "/local-housekeeping/worksheet",
        {
          ...scope,
          baseRevision: revision.current,
          mutationId: mutationId(),
          operations: ops,
        },
        "PUT",
      );
      revision.current = result.revision;
      const updated = ops.reduce(moveWorksheet, base);
      confirmed.current = { ...updated, revision: result.revision };
      setLastChange(result.changeId);
      adopt(queue.current.reduce(moveWorksheet, confirmed.current));
      await refresh();
    } catch (e) {
      queue.current = [];
      setLastChange(null);
      adopt(confirmed.current);
      setError(
        (e as Error).message + " Local pending moves have been rolled back.",
      );
      await refresh();
    } finally {
      inFlight.current = false;
      setSaving(false);
      setPending(queue.current.length > 0);
      if (queue.current.length)
        timer.current = setTimeout(() => void flushRef.current(), 500);
    }
  }, [adopt, refresh]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.current.length || inFlight.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      clearTimeout(timer.current);
      if (queue.current.length) void flushRef.current();
    };
  }, []);
  const move = useCallback(
    (operation: WorksheetOperation) => {
      if (!view.current?.canManage) return;
      setError("");
      queue.current.push(operation);
      adopt(moveWorksheet(view.current, operation));
      setPending(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flushRef.current(), 500);
    },
    [adopt],
  );
  async function undo() {
    if (inFlight.current) return;
    setError("");
    if (queue.current.length) {
      queue.current.pop();
      adopt(queue.current.reduce(moveWorksheet, confirmed.current!));
      setPending(queue.current.length > 0);
      if (!queue.current.length) clearTimeout(timer.current);
      return;
    }
    if (!lastChange || !view.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const result = await write("/local-housekeeping/worksheet/undo", {
        ...view.current.scope,
        baseRevision: revision.current,
        mutationId: mutationId(),
        changeId: lastChange,
      });
      revision.current = result.revision;
      setLastChange(null);
      await refresh();
      // The refreshed server response will restore the full saved assignment state.
      confirmed.current = undefined;
    } catch (e) {
      setError((e as Error).message);
      setLastChange(null);
      await refresh();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  // A refetch completed while a save/undo was in flight must be adopted afterwards.
  useEffect(() => {
    if (
      !saving &&
      !pending &&
      server &&
      BigInt(server.revision) >= BigInt(revision.current)
    ) {
      confirmed.current = server;
      revision.current = server.revision;
      adopt(server);
    }
  }, [saving, pending, server, adopt]);
  return {
    sheet,
    move,
    undo,
    pending,
    saving,
    error,
    canUndo: !saving && (pending || !!lastChange),
  };
}

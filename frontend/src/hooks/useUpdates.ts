import { useState, useEffect, useCallback, useRef } from 'react';

type CheckResult = 'up-to-date' | null;

interface UpdateState {
  updateAvailable: boolean;
  updateVersion: string | null;
  downloading: boolean;
  downloadProgress: number;
  downloaded: boolean;
  error: string | null;
  checking: boolean;
  lastCheckResult: CheckResult;
  checkForUpdate: () => void;
  downloadUpdate: () => void;
  installUpdate: () => void;
}

export function useUpdates(): UpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckResult, setLastCheckResult] = useState<CheckResult>(null);

  // Tracks whether the in-flight check was user-initiated, so we only
  // surface "up to date" feedback when the user clicked the button.
  const checkingRef = useRef(false);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updates = window.augustus?.updates;

  useEffect(() => {
    if (!updates) return;

    updates.onUpdateAvailable((info) => {
      checkingRef.current = false;
      setChecking(false);
      setUpdateAvailable(true);
      setUpdateVersion(info.version);
      setError(null);
    });

    updates.onUpdateNotAvailable(() => {
      const wasUserCheck = checkingRef.current;
      checkingRef.current = false;
      setChecking(false);
      setUpdateAvailable(false);
      if (wasUserCheck) {
        setLastCheckResult('up-to-date');
        if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
        resultTimerRef.current = setTimeout(() => setLastCheckResult(null), 4000);
      }
    });

    updates.onDownloadProgress((progress) => {
      setDownloading(true);
      setDownloadProgress(Math.round(progress.percent));
    });

    updates.onUpdateDownloaded(() => {
      setDownloading(false);
      setDownloaded(true);
      setDownloadProgress(100);
    });

    updates.onUpdateError((err) => {
      checkingRef.current = false;
      setChecking(false);
      setDownloading(false);
      setError(err);
    });

    return () => {
      updates.removeAllListeners();
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    };
  }, [updates]);

  const checkForUpdate = useCallback(() => {
    if (!updates) return;
    checkingRef.current = true;
    setChecking(true);
    setLastCheckResult(null);
    setError(null);
    updates.checkForUpdate().catch(() => {});
    // Safety net: in dev mode the main process returns null and no events
    // ever fire. Clear the spinner after 10s so the UI doesn't hang.
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      if (checkingRef.current) {
        checkingRef.current = false;
        setChecking(false);
      }
    }, 10000);
  }, [updates]);

  const downloadUpdate = useCallback(() => {
    if (!updates) return;
    setDownloading(true);
    setError(null);
    updates.downloadUpdate().catch((err) => {
      setDownloading(false);
      setError(String(err));
    });
  }, [updates]);

  const installUpdate = useCallback(() => {
    updates?.installUpdate().catch(() => {});
  }, [updates]);

  return {
    updateAvailable,
    updateVersion,
    downloading,
    downloadProgress,
    downloaded,
    error,
    checking,
    lastCheckResult,
    checkForUpdate,
    downloadUpdate,
    installUpdate,
  };
}

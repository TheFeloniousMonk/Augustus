import { Bell, Sun, Moon, Activity, Clock, Play, Pause, AlertTriangle, Info, X, RefreshCw, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../hooks/useTheme';
import StatusChip from '../ui/StatusChip';
import UpdateBanner from '../ui/UpdateBanner';
import McpReinstallBanner from '../ui/McpReinstallBanner';
import { useState, useEffect, useRef } from 'react';
import { api } from '../../api/client';
import { useAlertDismissals, alertDismissKey } from '../../hooks/useAlertDismissals';
import { useUpdates } from '../../hooks/useUpdates';
import type { SystemAlert } from '../../types';

interface TopbarProps {
  pageTitle?: string;
}

export default function Topbar({ pageTitle }: TopbarProps) {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [orchestratorStatus, setOrchestratorStatus] = useState<'running' | 'paused' | 'error' | 'idle'>('idle');
  const [activeSessions, setActiveSessions] = useState(0);
  const [queuedAgents, setQueuedAgents] = useState(0);
  const [budget, setBudget] = useState({ used: 0, total: 25 });
  const [isTogglingOrchestrator, setIsTogglingOrchestrator] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const { dismissed: dismissedAlerts, dismiss: dismissAlert } = useAlertDismissals();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const { checking, lastCheckResult, updateAvailable, downloading, downloaded, checkForUpdate } = useUpdates();

  useEffect(() => {
    window.augustus?.getAppVersion().then(setAppVersion).catch(() => {});
  }, []);

  const updateButtonTitle = lastCheckResult === 'up-to-date'
    ? "You're up to date"
    : checking
      ? 'Checking for updates...'
      : updateAvailable || downloading || downloaded
        ? 'Update pending — see banner above'
        : 'Check for updates';

  // Poll orchestrator status every 10 seconds
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await api.orchestrator.status();
        setOrchestratorStatus(status.status);
        setActiveSessions(status.active_sessions || 0);
        setQueuedAgents(status.queued_agents || 0);
      } catch (error) {
        console.error('Failed to fetch orchestrator status:', error);
        setOrchestratorStatus('error');
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Fetch alerts on mount and periodically
  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const data = await api.activity.alerts();
        setAlerts(data);
      } catch {
        // Silently keep current alerts
      }
    };
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, []);

  // Close notification panel when clicking outside
  useEffect(() => {
    if (!notifOpen) return;
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [notifOpen]);

  // Poll budget data every 30 seconds
  useEffect(() => {
    const fetchBudget = async () => {
      try {
        const usage = await api.usage.summary();
        setBudget({
          used: usage.total_cost || 0,
          total: usage.budget_limit || 25,
        });
      } catch (error) {
        console.error('Failed to fetch budget data:', error);
        // Silently keep defaults on error
      }
    };

    fetchBudget();
    const interval = setInterval(fetchBudget, 30000);
    return () => clearInterval(interval);
  }, []);

  const budgetPercentage = (budget.used / budget.total) * 100;
  const budgetColor = budgetPercentage > 75 ? 'red' : budgetPercentage > 50 ? 'amber' : 'green';

  const handleOrchestratorToggle = async () => {
    if (isTogglingOrchestrator) return;

    try {
      setIsTogglingOrchestrator(true);

      if (orchestratorStatus === 'running') {
        await api.orchestrator.pause();
        setOrchestratorStatus('paused');
      } else {
        await api.orchestrator.resume();
        setOrchestratorStatus('running');
      }
    } catch (error) {
      console.error('Failed to toggle orchestrator:', error);
      // Don't change status on error - keep the current state
      setToggleError('Failed to toggle orchestrator.');
      setTimeout(() => setToggleError(null), 3000);
    } finally {
      setIsTogglingOrchestrator(false);
    }
  };

  return (
    <>
    <UpdateBanner />
    <McpReinstallBanner />
    <header className="topbar">
      <div className="topbar-left">
        {pageTitle && <h1 className="page-title">{pageTitle}</h1>}
      </div>

      <div className="topbar-right">
        <button
          className="orchestrator-control-btn"
          onClick={handleOrchestratorToggle}
          disabled={isTogglingOrchestrator}
          title={orchestratorStatus === 'running' ? 'Pause orchestrator' : 'Start orchestrator'}
        >
          {orchestratorStatus === 'running' ? <Pause size={14} /> : <Play size={14} />}
          <StatusChip
            status={orchestratorStatus}
            label={`Orchestrator ${orchestratorStatus}`}
          />
        </button>

        <div className="status-chip">
          <Activity size={14} />
          {activeSessions} active
        </div>

        {queuedAgents > 0 && (
          <div className="status-chip" style={{ color: 'var(--accent-primary)' }}>
            <Clock size={14} />
            {queuedAgents} queued
          </div>
        )}

        <div
          className="budget-chip"
          onClick={() => navigate('/usage')}
          style={{ cursor: 'pointer' }}
          title="View usage details"
        >
          <span>${budget.used.toFixed(2)} / ${budget.total}</span>
          <div className="budget-bar">
            <div className={`budget-fill ${budgetColor}`} style={{ width: `${budgetPercentage}%` }} />
          </div>
        </div>

        {toggleError && (
          <span style={{ fontSize: '12px', color: 'var(--accent-alert)', padding: '2px var(--space-2)', background: 'var(--accent-alert-dim)', borderRadius: 'var(--radius-sm)' }}>
            {toggleError}
          </span>
        )}

        <div ref={notifRef} style={{ position: 'relative' }}>
          {(() => {
            const visibleAlerts = alerts.filter(
              a => !dismissedAlerts.has(alertDismissKey(a.link_type, a.agent_id, a.session_id))
            );
            return (
              <>
                <button
                  className="notification-btn"
                  title="Notifications"
                  onClick={() => setNotifOpen(o => !o)}
                  style={{ position: 'relative' }}
                >
                  <Bell size={20} />
                  {visibleAlerts.length > 0 && (
                    <span style={{
                      position: 'absolute', top: '2px', right: '2px',
                      width: '16px', height: '16px', borderRadius: '50%',
                      background: 'var(--accent-alert)', color: '#fff',
                      fontSize: '10px', fontWeight: 700, lineHeight: '16px', textAlign: 'center',
                      pointerEvents: 'none',
                    }}>
                      {visibleAlerts.length > 9 ? '9+' : visibleAlerts.length}
                    </span>
                  )}
                </button>

                {notifOpen && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                    width: '340px', maxHeight: '420px', overflowY: 'auto',
                    background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-card)',
                    zIndex: 1000,
                  }}>
                    <div style={{
                      padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border-color)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                        System Alerts
                      </span>
                      <button onClick={() => setNotifOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}>
                        <X size={16} />
                      </button>
                    </div>
                    {visibleAlerts.length === 0 ? (
                      <div style={{ padding: 'var(--space-5)', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
                        No active alerts
                      </div>
                    ) : visibleAlerts.map((alert) => {
                      const isError = alert.alert_type === 'error';
                      const alertColor = isError ? 'var(--accent-alert)' : 'var(--accent-attention)';
                      const alertDim = isError ? 'var(--accent-alert-dim)' : 'var(--accent-attention-dim)';
                      const AlertIcon = isError ? AlertTriangle : Info;
                      const link = alert.link_type === 'pending_proposals' && alert.agent_id
                        ? `/agents/${alert.agent_id}/proposals`
                        : alert.link_type === 'unreviewed_flags' && alert.agent_id
                        ? `/agents/${alert.agent_id}/flags`
                        : alert.link_type === 'constraint_erosion' && alert.agent_id
                        ? `/agents/${alert.agent_id}/flags`
                        : alert.link_type === 'session_failed' && alert.agent_id && alert.session_id
                        ? `/agents/${alert.agent_id}/sessions/${alert.session_id}`
                        : alert.link_type === 'session_failed' && alert.agent_id
                        ? `/agents/${alert.agent_id}/sessions`
                        : alert.link_type === 'agent_errors'
                        ? '/agents'
                        : alert.link_type === 'budget_warning'
                        ? '/usage'
                        : null;
                      return (
                        <div
                          key={alert.alert_id}
                          onClick={() => { if (link) { navigate(link); setNotifOpen(false); } }}
                          style={{
                            padding: 'var(--space-3) var(--space-4)',
                            borderBottom: '1px solid var(--border-color)',
                            cursor: link ? 'pointer' : 'default',
                            display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start',
                            transition: 'background var(--transition-color)',
                          }}
                          onMouseEnter={(e) => { if (link) e.currentTarget.style.background = 'var(--bg-raised)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <div style={{
                            width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
                            background: alertDim, color: alertColor, flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <AlertIcon size={14} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>
                              {alert.title}
                            </div>
                            {alert.detail && (
                              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                {alert.detail}
                              </div>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                dismissAlert(alertDismissKey(alert.link_type, alert.agent_id, alert.session_id));
                              }}
                              style={{
                                background: 'none', border: 'none', padding: 0, marginTop: '4px',
                                fontSize: '12px', color: 'var(--text-muted)', cursor: 'pointer',
                                textDecoration: 'underline', fontFamily: 'inherit',
                              }}
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {window.augustus && (
          <div className="topbar-update-control">
            {appVersion && (
              <span className="topbar-version" title={`Installed version v${appVersion}`}>
                v{appVersion}
              </span>
            )}
            <button
              className="topbar-update-check"
              onClick={checkForUpdate}
              disabled={checking}
              title={updateButtonTitle}
              aria-label={updateButtonTitle}
            >
              {lastCheckResult === 'up-to-date' ? (
                <Check size={14} />
              ) : (
                <RefreshCw size={14} className={checking ? 'spin' : undefined} />
              )}
            </button>
          </div>
        )}

        <div className="mode-switcher">
          <button
            className={`mode-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => toggleTheme()}
            title="Light mode"
          >
            <Sun size={16} />
          </button>
          <button
            className={`mode-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => toggleTheme()}
            title="Dark mode"
          >
            <Moon size={16} />
          </button>
        </div>
      </div>
    </header>
    </>
  );
}

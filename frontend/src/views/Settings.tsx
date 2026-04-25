import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, Check, X, AlertCircle, Loader2, FileText, Download, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import type { Settings as SettingsType } from '../types';
import Button from '../components/ui/Button';

export default function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<'unchecked' | 'validating' | 'valid' | 'invalid'>('unchecked');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [activeSection, setActiveSection] = useState('api');
  const [saveIndicator, setSaveIndicator] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetConfirm, setResetConfirm] = useState('');
  const [mcpStatus, setMcpStatus] = useState<'running' | 'stopped' | 'checking'>('checking');
  const [claudeExtStatus, setClaudeExtStatus] = useState<{ installed: boolean; enabled: boolean; claudeDesktopFound: boolean; needsReinstall?: boolean } | null>(null);
  const [claudeExtBusy, setClaudeExtBusy] = useState(false);
  const [claudeExtError, setClaudeExtError] = useState<string | null>(null);

  // Section refs for intersection observer
  const sectionRefs = useRef<{ [key: string]: HTMLElement | null }>({});
  const sectionsContainerRef = useRef<HTMLDivElement>(null);

  const { data: fetchedSettings, loading, error, refetch } = useApi<SettingsType>(
    () => api.settings.get(),
    [],
  );

  // Sync fetched settings into local state for mutation
  useEffect(() => {
    if (fetchedSettings) setSettings(fetchedSettings);
  }, [fetchedSettings]);

  useEffect(() => {
    checkMcpStatus();
    checkClaudeExtension();
  }, []);

  // Scroll to section if URL hash is present (e.g. /settings#integration)
  useEffect(() => {
    if (!settings) return; // Wait for settings to render sections
    const hash = location.hash.replace('#', '');
    if (hash && sectionRefs.current[hash]) {
      // Small delay to ensure DOM is laid out
      const timer = setTimeout(() => {
        sectionRefs.current[hash]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveSection(hash);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [settings, location.hash]);

  useEffect(() => {
    // Intersection observer for active section highlighting
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const sectionId = entry.target.id;
            setActiveSection(sectionId);
          }
        });
      },
      { threshold: 0.5, rootMargin: '-100px 0px -50% 0px' }
    );

    Object.values(sectionRefs.current).forEach((ref) => {
      if (ref) observer.observe(ref);
    });

    return () => observer.disconnect();
  }, [settings]);

  async function checkMcpStatus() {
    try {
      const status = await api.orchestrator.status();
      // If orchestrator responds, the backend is running — MCP availability
      // depends on the mcp_enabled setting
      setMcpStatus(status ? 'running' : 'stopped');
    } catch {
      setMcpStatus('stopped');
    }
  }

  async function checkClaudeExtension() {
    if (!window.augustus?.claudeExtension) return;
    try {
      const status = await window.augustus.claudeExtension.check();
      setClaudeExtStatus(status);
    } catch {
      setClaudeExtStatus(null);
    }
  }

  async function handleInstallClaudeExtension() {
    if (!window.augustus?.claudeExtension || !settings) return;
    setClaudeExtBusy(true);
    setClaudeExtError(null);
    try {
      const result = await window.augustus.claudeExtension.install(settings.data_directory);
      if (result.success) {
        await checkClaudeExtension();
      } else {
        setClaudeExtError(result.error || 'Installation failed');
      }
    } catch (err) {
      setClaudeExtError(err instanceof Error ? err.message : 'Installation failed');
    } finally {
      setClaudeExtBusy(false);
    }
  }

  async function handleUninstallClaudeExtension() {
    if (!window.augustus?.claudeExtension) return;
    setClaudeExtBusy(true);
    setClaudeExtError(null);
    try {
      const result = await window.augustus.claudeExtension.uninstall();
      if (result.success) {
        await checkClaudeExtension();
      } else {
        setClaudeExtError(result.error || 'Uninstall failed');
      }
    } catch (err) {
      setClaudeExtError(err instanceof Error ? err.message : 'Uninstall failed');
    } finally {
      setClaudeExtBusy(false);
    }
  }

  async function validateApiKey() {
    if (!apiKeyInput) return;
    setApiKeyStatus('validating');
    try {
      const result = await api.settings.validateKey(apiKeyInput);
      setApiKeyStatus(result.valid ? 'valid' : 'invalid');
    } catch {
      setApiKeyStatus('invalid');
    }
  }

  async function saveApiKey() {
    if (!apiKeyInput) return;
    try {
      await api.settings.update({ api_key: apiKeyInput } as any);
      setSettings((prev) => prev ? { ...prev, has_api_key: true } : prev);
      setApiKeyDirty(false);
      showSaveIndicator();
    } catch (err) {
      console.error('Failed to save API key:', err);
      alert(`Failed to save API key: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  function updateSetting<K extends keyof SettingsType>(key: K, value: SettingsType[K]) {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    debouncedSave({ ...settings, [key]: value });
  }

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  function debouncedSave(newSettings: SettingsType) {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        // Exclude read-only fields from the update payload
        const { has_api_key, ...payload } = newSettings;
        await api.settings.update(payload);
        showSaveIndicator();
      } catch (err) {
        console.error('Failed to save settings:', err);
        alert(`Failed to save settings: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }, 500);
  }

  function showSaveIndicator() {
    setSaveIndicator(true);
    setTimeout(() => setSaveIndicator(false), 2000);
  }

  function scrollToSection(sectionId: string) {
    const section = sectionRefs.current[sectionId];
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function handleResetDatabase() {
    if (resetConfirm !== 'RESET') return;
    // TODO: wire to API when reset endpoint is implemented
    setShowResetModal(false);
    setResetConfirm('');
  }

  if (loading) {
    return (
      <div style={{
        padding: 'var(--space-6)',
        color: 'var(--text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)'
      }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        Loading settings...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: 'var(--space-6)',
        maxWidth: '600px',
        margin: '0 auto'
      }}>
        <div style={{
          padding: 'var(--space-5)',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--accent-alert)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          alignItems: 'center',
          textAlign: 'center'
        }}>
          <AlertCircle size={48} style={{ color: 'var(--accent-alert)' }} />
          <div>
            <h2 style={{
              fontSize: 'var(--font-size-xl)',
              fontWeight: 600,
              color: 'var(--text-primary)',
              marginBottom: 'var(--space-2)'
            }}>
              Failed to load settings
            </h2>
            <p style={{
              color: 'var(--text-secondary)',
              fontSize: 'var(--font-size-sm)'
            }}>
              {error}
            </p>
          </div>
          <Button variant="primary" onClick={refetch}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div style={{
        padding: 'var(--space-6)',
        color: 'var(--text-secondary)',
        textAlign: 'center'
      }}>
        No settings available
      </div>
    );
  }

  const budgetPercent = (settings.budget_warning > 0)
    ? Math.min((100 / settings.budget_warning) * 100, 100)
    : 0;
  const budgetColor = budgetPercent > 80 ? 'red' : budgetPercent > 50 ? 'amber' : 'green';

  return (
    <div className="settings-page" ref={sectionsContainerRef}>
      <div className="settings-layout">
        {/* Left side navigation */}
        <nav className="settings-nav">
          {[
            { id: 'api', label: 'API Configuration' },
            { id: 'model', label: 'Model Defaults' },
            { id: 'orchestrator', label: 'Orchestrator' },
            { id: 'budget', label: 'Budget' },
            { id: 'evaluation', label: 'Evaluation' },
            { id: 'integration', label: 'Integration' },
            { id: 'data', label: 'Data' },
          ].map((section) => (
            <div
              key={section.id}
              className={`settings-nav-item ${activeSection === section.id ? 'active' : ''}`}
              onClick={() => scrollToSection(section.id)}
            >
              {section.label}
            </div>
          ))}
        </nav>

        {/* Main content */}
        <div className="settings-content">
          {/* API Configuration */}
          <section
            className="settings-section"
            id="api"
            ref={(el) => (sectionRefs.current.api = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">API Configuration</h2>
              {saveIndicator && (
                <span className="save-indicator visible" style={{ fontSize: '13px', color: 'var(--accent-success)' }}>
                  <Check size={14} style={{ display: 'inline', marginRight: '4px' }} />
                  Saved
                </span>
              )}
            </div>
            <div className="settings-section-body">
              <div className="form-group">
                <label className="form-label">Anthropic API Key</label>
                <div className="input-with-button">
                  <div className="input-with-icon">
                    <input
                      type={apiKeyVisible ? 'text' : 'password'}
                      className="form-input mono"
                      value={apiKeyInput}
                      onChange={(e) => {
                        setApiKeyInput(e.target.value);
                        setApiKeyDirty(true);
                        setApiKeyStatus('unchecked');
                      }}
                      placeholder={settings.has_api_key ? 'sk-ant-••••••••••••' : 'sk-ant-...'}
                    />
                    <span
                      className="input-icon-right"
                      onClick={() => setApiKeyVisible(!apiKeyVisible)}
                    >
                      {apiKeyVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                    </span>
                  </div>
                  {apiKeyDirty ? (
                    <Button variant="primary" onClick={saveApiKey}>Save Key</Button>
                  ) : apiKeyStatus === 'valid' || (settings.has_api_key && !apiKeyInput) ? (
                    <Button variant="primary" disabled>
                      <Check size={16} /> Valid
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={validateApiKey} disabled={!apiKeyInput && !settings.has_api_key}>
                      {apiKeyStatus === 'validating' ? <Loader2 size={16} /> : 'Validate'}
                    </Button>
                  )}
                </div>
                {settings.has_api_key && !apiKeyDirty && (
                  <div className="form-hint" style={{ marginTop: 'var(--space-2)' }}>
                    API key is stored (encrypted). Enter a new key to replace it.
                  </div>
                )}
                {apiKeyStatus !== 'unchecked' && (
                  <div
                    className={`api-key-status ${apiKeyStatus}`}
                    style={{ marginTop: 'var(--space-2)' }}
                  >
                    {apiKeyStatus === 'validating' && (
                      <>
                        <Loader2 size={16} />
                        Validating...
                      </>
                    )}
                    {apiKeyStatus === 'valid' && (
                      <>
                        <Check size={16} />
                        API key is valid
                      </>
                    )}
                    {apiKeyStatus === 'invalid' && (
                      <>
                        <X size={16} />
                        Invalid API key
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Model Defaults */}
          <section
            className="settings-section"
            id="model"
            ref={(el) => (sectionRefs.current.model = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">Model Defaults</h2>
            </div>
            <div className="settings-section-body">
              <div className="form-group">
                <label className="form-label">Default Model</label>
                <select
                  className="form-select"
                  value={settings.default_model}
                  onChange={(e) => updateSetting('default_model', e.target.value)}
                >
                  <option value="claude-opus-4-7">claude-opus-4-7</option>
                  <option value="claude-opus-4-6">claude-opus-4-6</option>
                  <option value="claude-opus-4-5-20251101">claude-opus-4-5-20251101</option>
                  <option value="claude-opus-4-1-20250805">claude-opus-4-1-20250805</option>
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  <option value="claude-sonnet-4-5-20250929">claude-sonnet-4-5-20250929</option>
                  <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Temperature</label>
                <div className="slider-wrapper">
                  <input
                    type="range"
                    className="slider"
                    min="0"
                    max="2"
                    step="0.1"
                    value={settings.default_temperature}
                    onChange={(e) => updateSetting('default_temperature', parseFloat(e.target.value))}
                  />
                  <span className="slider-value">{settings.default_temperature.toFixed(1)}</span>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Max Tokens</label>
                  <input
                    type="number"
                    className="form-input"
                    value={settings.default_max_tokens}
                    onChange={(e) => updateSetting('default_max_tokens', parseInt(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Max Turns</label>
                  <input
                    type="number"
                    className="form-input"
                    value={settings.poll_interval}
                    onChange={(e) => updateSetting('poll_interval', parseInt(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Orchestrator */}
          <section
            className="settings-section"
            id="orchestrator"
            ref={(el) => (sectionRefs.current.orchestrator = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">Orchestrator</h2>
            </div>
            <div className="settings-section-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Poll Interval (seconds)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={settings.poll_interval}
                    onChange={(e) => updateSetting('poll_interval', parseInt(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Max Concurrent Agents</label>
                  <input
                    type="number"
                    className="form-input"
                    value={settings.max_concurrent_agents}
                    onChange={(e) => updateSetting('max_concurrent_agents', parseInt(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Budget */}
          <section
            className="settings-section"
            id="budget"
            ref={(el) => (sectionRefs.current.budget = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">Budget</h2>
            </div>
            <div className="settings-section-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Warning Threshold (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="form-input"
                    value={settings.budget_warning}
                    onChange={(e) => updateSetting('budget_warning', parseFloat(e.target.value))}
                  />
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <div className="budget-bar">
                      <div className={`budget-fill ${budgetColor}`} style={{ width: `${budgetPercent}%` }} />
                    </div>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Hard Stop (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="form-input"
                    value={settings.budget_hard_stop}
                    onChange={(e) => updateSetting('budget_hard_stop', parseFloat(e.target.value))}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Per Session Limit (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="form-input"
                    value={settings.budget_per_session}
                    onChange={(e) => updateSetting('budget_per_session', parseFloat(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Per Day Limit (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="form-input"
                    value={settings.budget_per_day}
                    onChange={(e) => updateSetting('budget_per_day', parseFloat(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Evaluation */}
          <section
            className="settings-section"
            id="evaluation"
            ref={(el) => (sectionRefs.current.evaluation = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">Evaluation</h2>
            </div>
            <div className="settings-section-body">
              <div className="form-group">
                <div className="toggle-wrapper">
                  <div
                    className={`toggle ${settings.evaluator_enabled ? 'active' : ''}`}
                    onClick={() => updateSetting('evaluator_enabled', !settings.evaluator_enabled)}
                  />
                  <span className="toggle-label">Evaluator Enabled</span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Evaluator Model</label>
                <select
                  className="form-select"
                  value={settings.evaluator_model}
                  onChange={(e) => updateSetting('evaluator_model', e.target.value)}
                  disabled={!settings.evaluator_enabled}
                >
                  <option value="claude-opus-4-7">claude-opus-4-7</option>
                  <option value="claude-opus-4-6">claude-opus-4-6</option>
                  <option value="claude-opus-4-5-20251101">claude-opus-4-5-20251101</option>
                  <option value="claude-opus-4-1-20250805">claude-opus-4-1-20250805</option>
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  <option value="claude-sonnet-4-5-20250929">claude-sonnet-4-5-20250929</option>
                  <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
                </select>
              </div>

              <div className="form-group">
                <div className="toggle-wrapper">
                  <div
                    className={`toggle ${settings.formula_in_identity_core ? 'active' : ''}`}
                    onClick={() => updateSetting('formula_in_identity_core', !settings.formula_in_identity_core)}
                  />
                  <span className="toggle-label">Include Formula in Identity Core (A/B Flag)</span>
                </div>
                <p className="form-hint">
                  Experimental: Include decay/boost formulas in the agent identity core prompt
                </p>
              </div>

              <div className="form-group" style={{ paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-subtle)' }}>
                <Button
                  variant="secondary"
                  onClick={() => navigate('/settings/evaluator-prompts')}
                >
                  <FileText size={16} />
                  Manage Evaluator Prompts
                </Button>
                <p className="form-hint" style={{ marginTop: 'var(--space-2)' }}>
                  View, create, and activate evaluator prompt versions
                </p>
              </div>
            </div>
          </section>

          {/* Integration */}
          <section
            className="settings-section"
            id="integration"
            ref={(el) => (sectionRefs.current.integration = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">Integration</h2>
            </div>
            <div className="settings-section-body">
              <div className="form-group">
                <div className="toggle-wrapper">
                  <div
                    className={`toggle ${settings.mcp_enabled ? 'active' : ''}`}
                    onClick={() => updateSetting('mcp_enabled', !settings.mcp_enabled)}
                  />
                  <span className="toggle-label">Enable MCP server for Claude Desktop integration</span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">MCP Server Status</label>
                <div className={`mcp-status ${settings.mcp_enabled && mcpStatus === 'running' ? 'running' : 'stopped'}`}>
                  <span className="status-indicator" />
                  {mcpStatus === 'checking'
                    ? 'Checking...'
                    : settings.mcp_enabled && mcpStatus === 'running'
                      ? 'Running'
                      : 'Stopped'}
                </div>
              </div>

              {/* Claude Desktop Extension — one-click install */}
              {window.augustus?.claudeExtension ? (
                <div className="form-group" style={{ paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-subtle)' }}>
                  <label className="form-label">Claude Desktop Extension</label>
                  {claudeExtStatus === null ? (
                    <p className="form-hint">Checking extension status...</p>
                  ) : !claudeExtStatus.claudeDesktopFound ? (
                    <p className="form-hint" style={{ color: 'var(--text-tertiary)' }}>
                      Claude Desktop is not installed. Install it from claude.ai to enable one-click integration.
                    </p>
                  ) : claudeExtStatus.installed && !claudeExtStatus.needsReinstall ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                        <div className={`mcp-status ${claudeExtStatus.enabled ? 'running' : 'stopped'}`}>
                          <span className="status-indicator" />
                          {claudeExtStatus.enabled ? 'Installed and enabled' : 'Installed but disabled'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                        <Button
                          variant="secondary"
                          onClick={handleInstallClaudeExtension}
                          disabled={claudeExtBusy}
                        >
                          {claudeExtBusy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={16} />}
                          Reinstall
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={handleUninstallClaudeExtension}
                          disabled={claudeExtBusy}
                        >
                          <Trash2 size={16} />
                          Uninstall
                        </Button>
                      </div>
                      <p className="form-hint">
                        Restart Claude Desktop after changes for them to take effect.
                      </p>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                      <p className="form-hint">
                        {claudeExtStatus.needsReinstall
                          ? 'The Augustus extension needs to be reinstalled for this version. Click below to update it.'
                          : 'Install the Augustus extension into Claude Desktop for direct MCP tool access. Your data directory will be configured automatically.'}
                      </p>
                      <Button
                        variant="primary"
                        onClick={handleInstallClaudeExtension}
                        disabled={claudeExtBusy}
                      >
                        {claudeExtBusy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={16} />}
                        {claudeExtStatus.needsReinstall ? 'Reinstall Extension' : 'Install Claude Desktop Extension'}
                      </Button>
                      <p className="form-hint">
                        Restart Claude Desktop after installing for the extension to appear.
                      </p>
                    </div>
                  )}
                  {claudeExtError && (
                    <div style={{ marginTop: 'var(--space-2)', color: 'var(--accent-alert)', fontSize: 'var(--font-size-sm)' }}>
                      <AlertCircle size={14} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
                      {claudeExtError}
                    </div>
                  )}
                </div>
              ) : (
                /* Non-Electron: extension status cannot be verified */
                <div className="form-group" style={{ paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-subtle)' }}>
                  <label className="form-label">Claude Desktop Extension</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                    <div className="mcp-status stopped">
                      <span className="status-indicator" />
                      Not verified
                    </div>
                    <p className="form-hint">
                      Extension status cannot be checked in development mode. Use the packaged Electron app to install and manage the Claude Desktop extension, or configure MCP manually.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Data */}
          <section
            className="settings-section"
            id="data"
            ref={(el) => (sectionRefs.current.data = el)}
          >
            <div className="settings-section-header">
              <h2 className="settings-section-title">Data</h2>
            </div>
            <div className="settings-section-body">
              <div className="form-group">
                <label className="form-label">Data Directory</label>
                <div className="path-display">
                  <div className="path-value">{settings.data_directory}</div>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Database Size</label>
                <div className="db-sizes">
                  <div className="db-size-badge">
                    <AlertCircle size={14} />
                    SQLite: 47.2 MB
                  </div>
                  <div className="db-size-badge">
                    <AlertCircle size={14} />
                    ChromaDB: 128.5 MB
                  </div>
                </div>
              </div>

              <div className="form-group">
                <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <Button variant="secondary">Export All Data</Button>
                  <Button variant="destructive" onClick={() => setShowResetModal(true)}>
                    Reset Database
                  </Button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetModal && (
        <div className="modal-overlay open" onClick={() => setShowResetModal(false)}>
          <div className="modal modal-md" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Reset Database</h2>
              <button className="modal-close" onClick={() => setShowResetModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="reset-warning">
                <AlertCircle className="reset-warning-icon" />
                <div className="reset-warning-content">
                  <div className="reset-warning-title">This action cannot be undone</div>
                  <div className="reset-warning-text">
                    This will permanently delete:
                  </div>
                  <ul className="reset-warning-list">
                    <li>All agent configurations and identity cores</li>
                    <li>All session records and transcripts</li>
                    <li>All evaluator outputs and flags</li>
                    <li>All tier proposals and annotations</li>
                  </ul>
                </div>
              </div>

              <div className="confirm-input-wrapper">
                <div className="confirm-input-label">
                  Type <code>RESET</code> to confirm:
                </div>
                <input
                  type="text"
                  className="form-input"
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  placeholder="RESET"
                />
              </div>
            </div>
            <div className="modal-footer">
              <Button variant="secondary" onClick={() => setShowResetModal(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleResetDatabase}
                disabled={resetConfirm !== 'RESET'}
              >
                Reset Database
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

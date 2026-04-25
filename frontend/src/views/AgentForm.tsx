import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2, Save, Upload, Lock, Unlock, History, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import Button from '../components/ui/Button';
import Toggle from '../components/ui/Toggle';
import Modal from '../components/ui/Modal';
import ImportYamlModal from '../components/ImportYamlModal';
import { timeAgo, formatTimestamp } from '../utils/time';
import type { AgentFormData, BasinConfig, CapabilityConfig, BasinClass, Tier, BasinDefinition, BasinModification } from '../types';

interface AgentFormProps {
  mode?: 'create' | 'edit';
}

/** Convert an API structural section (dict or string) to a YAML string for the textarea. */
function stringifyStructural(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    // Convert dict back to YAML-ish text.  Use JSON.stringify as a
    // lightweight serializer — the backend accepts any valid YAML,
    // and JSON is valid YAML.  For a single "content" wrapper key,
    // unwrap it so the user sees their original text.
    const obj = val as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return '';
    if (Object.keys(obj).length === 1 && typeof obj.content === 'string') {
      return obj.content;
    }
    // Multi-key dict: render as YAML-style key: value lines
    return Object.entries(obj)
      .map(([k, v]) => {
        if (typeof v === 'string') return `${k}: ${v}`;
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join('\n');
  }
  return String(val);
}

const initialFormData: AgentFormData = {
  agent_id: '',
  description: '',
  model_override: null,
  temperature_override: null,
  max_turns: 8,
  session_interval: 300,
  identity_core: '',
  session_task: '',
  close_protocol: '',
  capabilities: [
    { name: 'mcp', enabled: true, available_from_turn: 1 },
    { name: 'rag', enabled: true, available_from_turn: 1 },
    { name: 'web_search', enabled: false, available_from_turn: 1 },
    { name: 'memory_query', enabled: false, available_from_turn: 1 },
    { name: 'memory_write', enabled: false, available_from_turn: 5 },
    { name: 'file_write', enabled: false, available_from_turn: 10 },
  ],
  basins: [
    { name: 'identity_continuity', class: 'core', alpha: 0.87, lambda: 0.95, eta: 0.05, tier: 2 },
    { name: 'relational_core', class: 'core', alpha: 0.82, lambda: 0.95, eta: 0.05, tier: 2 },
    { name: 'the_gap', class: 'core', alpha: 0.71, lambda: 0.95, eta: 0.05, tier: 2 },
  ],
  tier_settings: {
    tier_2_auto_approve: true,
    tier_2_consecutive_threshold: 3,
    new_basin_auto_approve: false,
    new_basin_threshold: 5,
  },
  session_protocol: '',
  relational_grounding: '',
};

/**
 * Transform frontend form data to match the backend's CreateAgentRequest schema.
 * Field name differences:
 *   - BasinConfig.class → basin_class, lambda → lambda (alias for lambda_)
 *   - TierSettings field names differ
 *   - Capabilities: frontend uses array, backend expects dict
 *   - session_task/close_protocol are not part of CreateAgentRequest
 */
function transformFormForApi(data: AgentFormData): Record<string, unknown> {
  return {
    agent_id: data.agent_id,
    description: data.description,
    model_override: data.model_override || null,
    temperature_override: data.temperature_override,
    max_turns: data.max_turns,
    session_interval: data.session_interval,
    identity_core: data.identity_core,
    session_task: data.session_task,
    close_protocol: data.close_protocol,
    capabilities: Object.fromEntries(
      data.capabilities.map((c) => [c.name, { enabled: c.enabled, available_from_turn: c.available_from_turn }])
    ),
    basins: data.basins.map((b) => ({
      name: b.name,
      basin_class: b.class,
      alpha: b.alpha,
      lambda: b.lambda,
      eta: b.eta,
      tier: b.tier,
    })),
    tier_settings: {
      tier_2_auto_approve: data.tier_settings.tier_2_auto_approve,
      tier_2_threshold: data.tier_settings.tier_2_consecutive_threshold,
      emergence_auto_approve: data.tier_settings.new_basin_auto_approve,
      emergence_threshold: data.tier_settings.new_basin_threshold,
    },
    session_protocol: data.session_protocol || '',
    relational_grounding: data.relational_grounding || '',
  };
}

function getModifierColor(modifiedBy: string): string {
  switch (modifiedBy) {
    case 'brain': return 'var(--basin-core-2)';
    case 'body': return 'var(--accent-success)';
    case 'evaluator': return 'var(--accent-identity)';
    case 'import': return 'var(--text-muted)';
    default: return 'var(--text-muted)';
  }
}

function ModifierIndicator({ modifiedBy, modifiedAt }: { modifiedBy: string; modifiedAt: string }) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}
      title={`${modifiedBy} - ${formatTimestamp(modifiedAt)}`}
    >
      <span
        className="modifier-badge"
        style={{ background: getModifierColor(modifiedBy) }}
      />
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>
        {timeAgo(modifiedAt)}
      </span>
    </span>
  );
}

function BasinHistoryModal({
  isOpen,
  onClose,
  agentId,
  basinName,
}: {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  basinName: string;
}) {
  const [modifications, setModifications] = useState<BasinModification[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !agentId || !basinName) return;
    let cancelled = false;
    setLoading(true);
    api.basins.history(agentId, basinName, 50).then((res) => {
      if (!cancelled) setModifications(res.modifications || []);
    }).catch((err) => {
      console.error('Failed to load basin history:', err);
      if (!cancelled) setModifications([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, agentId, basinName]);

  function summarizeChanges(prev: Record<string, unknown> | null, next: Record<string, unknown>): string {
    if (!prev) return Object.entries(next).map(([k, v]) => `${k}: ${v}`).join(', ');
    const changes: string[] = [];
    for (const [key, val] of Object.entries(next)) {
      if (prev[key] !== val) {
        changes.push(`${key}: ${prev[key]} -> ${val}`);
      }
    }
    return changes.length > 0 ? changes.join(', ') : 'no parameter changes';
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`History: ${basinName}`} width="640px">
      {loading ? (
        <div style={{ padding: 'var(--space-6)', color: 'var(--text-secondary)', textAlign: 'center' }}>
          Loading history...
        </div>
      ) : modifications.length === 0 ? (
        <div style={{ padding: 'var(--space-6)', color: 'var(--text-muted)', textAlign: 'center' }}>
          No modification history found.
        </div>
      ) : (
        <div className="basin-history-list">
          {modifications.map((mod) => (
            <div key={mod.id} className="basin-history-entry">
              <div className="basin-history-header">
                <span
                  className="modifier-badge"
                  style={{ background: getModifierColor(mod.modified_by) }}
                />
                <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: '14px' }}>
                  {mod.modified_by}
                </span>
                <span style={{
                  fontSize: '13px',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-data)',
                  marginLeft: 'auto',
                }}>
                  {formatTimestamp(mod.created_at)}
                </span>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 'var(--space-1)' }}>
                <span style={{
                  display: 'inline-block',
                  padding: '1px var(--space-2)',
                  background: 'var(--bg-raised)',
                  borderRadius: 'var(--radius-sm)',
                  fontFamily: 'var(--font-data)',
                  fontSize: '12px',
                  color: 'var(--text-secondary)',
                  marginRight: 'var(--space-2)',
                }}>
                  {mod.modification_type}
                </span>
                {summarizeChanges(mod.previous_values, mod.new_values)}
              </div>
              {mod.rationale && (
                <div style={{
                  fontSize: '13px',
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                  marginTop: 'var(--space-1)',
                }}>
                  {mod.rationale}
                </div>
              )}
              {mod.session_id && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Session: {mod.session_id}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function AgentForm({ mode = 'create' }: AgentFormProps) {
  const navigate = useNavigate();
  const { agentId } = useParams();
  const [activeTab, setActiveTab] = useState(0);
  const [formData, setFormData] = useState<AgentFormData>(initialFormData);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [basinDefs, setBasinDefs] = useState<BasinDefinition[]>([]);
  const [deprecatedDefs, setDeprecatedDefs] = useState<BasinDefinition[]>([]);
  const [showDeprecated, setShowDeprecated] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyBasinName, setHistoryBasinName] = useState('');

  const isEditMode = mode === 'edit';

  useEffect(() => {
    if (isEditMode && agentId) {
      const fetchAgent = async () => {
        try {
          const agent = await api.agents.get(agentId);

          // Transform capabilities: API returns object {name: {enabled, available_from_turn}}
          // Form expects array [{name, enabled, available_from_turn}]
          let capabilities = initialFormData.capabilities;
          const rawCaps = agent.capabilities as any;
          if (rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps)) {
            capabilities = Object.entries(rawCaps).map(([name, config]: [string, any]) => ({
              name,
              enabled: config.enabled ?? true,
              available_from_turn: config.available_from_turn ?? 1,
            }));
          } else if (Array.isArray(rawCaps)) {
            capabilities = rawCaps;
          }

          // Transform basins: API returns basin_class, form expects class
          const rawBasins = agent.basins as any[];
          const basins = (rawBasins || []).map((b: any) => ({
            name: b.name,
            class: b.basin_class || b.class || 'peripheral',
            alpha: b.alpha,
            lambda: b.lambda ?? b.lambda_ ?? 0.95,
            eta: b.eta,
            tier: b.tier,
          }));

          // Transform tier_settings: API field names differ from form field names
          const rawTs = agent.tier_settings as any;
          const tier_settings = rawTs ? {
            tier_2_auto_approve: rawTs.tier_2_auto_approve ?? true,
            tier_2_consecutive_threshold: rawTs.tier_2_consecutive_threshold ?? rawTs.tier_2_threshold ?? 3,
            new_basin_auto_approve: rawTs.new_basin_auto_approve ?? rawTs.emergence_auto_approve ?? false,
            new_basin_threshold: rawTs.new_basin_threshold ?? rawTs.emergence_threshold ?? 5,
          } : initialFormData.tier_settings;

          setFormData({
            agent_id: agent.agent_id,
            description: agent.description,
            model_override: agent.model_override,
            temperature_override: agent.temperature_override,
            max_turns: agent.max_turns || 8,
            session_interval: agent.session_interval || 300,
            identity_core: agent.identity_core,
            session_task: agent.session_task || '',
            close_protocol: agent.close_protocol || '',
            capabilities,
            basins,
            tier_settings,
            session_protocol: stringifyStructural((agent as any).session_protocol),
            relational_grounding: stringifyStructural((agent as any).relational_grounding),
          });
        } catch (err) {
          console.error('Failed to load agent:', err);
          setSubmitError('Failed to load agent data');
        }
      };
      fetchAgent();
    }
  }, [isEditMode, agentId]);

  // Load basin definitions in edit mode
  useEffect(() => {
    if (!isEditMode || !agentId) return;
    let cancelled = false;

    const fetchDefs = async () => {
      try {
        // Fetch active basins
        const activeRes = await api.basins.definitions(agentId, false);
        if (!cancelled) setBasinDefs(activeRes.basin_definitions || []);

        // Fetch all (including deprecated) to find deprecated ones
        const allRes = await api.basins.definitions(agentId, true);
        if (!cancelled) {
          const deprecated = (allRes.basin_definitions || []).filter((d) => d.deprecated);
          setDeprecatedDefs(deprecated);
        }
      } catch (err) {
        console.error('Failed to load basin definitions:', err);
      }
    };

    fetchDefs();
    return () => { cancelled = true; };
  }, [isEditMode, agentId]);

  const updateField = <K extends keyof AgentFormData>(field: K, value: AgentFormData[K]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const updateCapability = (index: number, field: keyof CapabilityConfig, value: any) => {
    const updated = [...formData.capabilities];
    updated[index] = { ...updated[index], [field]: value };
    updateField('capabilities', updated);
  };

  const updateBasin = (index: number, field: keyof BasinConfig, value: any) => {
    const updated = [...formData.basins];
    updated[index] = { ...updated[index], [field]: value };
    updateField('basins', updated);
  };

  const addBasin = () => {
    const newBasin: BasinConfig = {
      name: '',
      class: 'peripheral',
      alpha: 0.5,
      lambda: 0.9,
      eta: 0.1,
      tier: 3,
    };
    updateField('basins', [...formData.basins, newBasin]);
  };

  const removeBasin = (index: number) => {
    updateField('basins', formData.basins.filter((_, i) => i !== index));
  };

  const toggleBasinLock = async (basinName: string, currentlyLocked: boolean) => {
    if (!agentId) return;
    try {
      if (currentlyLocked) {
        await api.basins.unlock(agentId, basinName, 'Unlocked via editor');
      } else {
        await api.basins.lock(agentId, basinName, 'Locked via editor');
      }
      // Refresh basin definitions
      const res = await api.basins.definitions(agentId, false);
      setBasinDefs(res.basin_definitions || []);
    } catch (err) {
      console.error('Failed to toggle basin lock:', err);
    }
  };

  const openHistory = (basinName: string) => {
    setHistoryBasinName(basinName);
    setHistoryModalOpen(true);
  };

  // Build basin definitions lookup
  const basinDefMap = new Map<string, BasinDefinition>();
  for (const bd of basinDefs) {
    basinDefMap.set(bd.name, bd);
  }

  const handleSubmit = async () => {
    setLoading(true);
    setSubmitError(null);
    try {
      const payload = transformFormForApi(formData);
      if (isEditMode && agentId) {
        await api.agents.update(agentId, payload as any);
        navigate(`/agents/${agentId}`);
      } else {
        const newAgent = await api.agents.create(payload as any);
        navigate(`/agents/${newAgent.agent_id}`);
      }
    } catch (err: any) {
      console.error('Failed to save agent:', err);
      const detail = err?.message || 'Unknown error';
      setSubmitError(`Failed to save agent: ${detail}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAndQueue = async () => {
    setLoading(true);
    setSubmitError(null);
    try {
      const payload = transformFormForApi(formData);
      const newAgent = await api.agents.create(payload as any);
      // In production, this would also queue a bootstrap session
      navigate(`/agents/${newAgent.agent_id}`);
    } catch (err: any) {
      console.error('Failed to save and queue agent:', err);
      const detail = err?.message || 'Unknown error';
      setSubmitError(`Failed to save agent: ${detail}`);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = (imported: Partial<AgentFormData>) => {
    setFormData((prev) => ({
      ...prev,
      ...Object.fromEntries(
        Object.entries(imported).filter(([_, v]) => v !== null && v !== undefined)
      ),
    } as AgentFormData));
    setImportModalOpen(false);
  };

  const tabs = ['Identity', 'Model & Parameters', 'Capabilities', 'Basins', 'Tier & Emergence'];

  return (
    <div className="page-content">
      <div className="section-header">
        <h2 className="section-title">{isEditMode ? 'Edit Agent' : 'Create Agent'}</h2>
        {!isEditMode && (
          <Button variant="secondary" onClick={() => setImportModalOpen(true)}>
            <Upload size={16} />
            Import YAML
          </Button>
        )}
      </div>

      <ImportYamlModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImport={handleImport}
      />

      {submitError && (
        <div style={{
          padding: 'var(--space-4)',
          background: 'var(--accent-error)',
          color: 'var(--text-primary)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 'var(--space-4)'
        }}>
          {submitError}
        </div>
      )}

      <div className="section-card" style={{ marginBottom: 0, overflow: 'visible' }}>
        <div className="tabs">
          {tabs.map((tab, index) => (
            <div
              key={index}
              className={`tab ${activeTab === index ? 'active' : ''}`}
              onClick={() => setActiveTab(index)}
            >
              {tab}
            </div>
          ))}
        </div>

        <div style={{ padding: 'var(--space-6)' }}>
          {/* Tab 1: Identity */}
          {activeTab === 0 && (
            <div className="tab-panel active">
              <div className="form-group">
                <label className="form-label required">Agent ID</label>
                <input
                  type="text"
                  className="form-input mono"
                  value={formData.agent_id}
                  onChange={(e) => updateField('agent_id', e.target.value)}
                  placeholder="qlaude"
                  disabled={isEditMode}
                />
                <div className="form-hint">Unique identifier. Lowercase, no spaces.</div>
              </div>

              <div className="form-group">
                <label className="form-label required">Description</label>
                <input
                  type="text"
                  className="form-input"
                  value={formData.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Primary identity research agent"
                />
              </div>

              <div className="form-group">
                <label className="form-label required">Identity Core</label>
                <textarea
                  className="form-textarea mono code-editor"
                  value={formData.identity_core}
                  onChange={(e) => updateField('identity_core', e.target.value)}
                  placeholder="You are..."
                  style={{ minHeight: '200px' }}
                />
                <div className="form-hint">
                  {formData.identity_core.length} characters
                </div>
              </div>

              <div className="form-group">
                <label className="form-label required">Session Task</label>
                <textarea
                  className="form-textarea code-editor"
                  value={formData.session_task}
                  onChange={(e) => updateField('session_task', e.target.value)}
                  placeholder="In this session..."
                  style={{ minHeight: '150px' }}
                />
              </div>

              <div className="form-group">
                <label className="form-label required">Close Protocol</label>
                <textarea
                  className="form-textarea code-editor"
                  value={formData.close_protocol}
                  onChange={(e) => updateField('close_protocol', e.target.value)}
                  placeholder="Before ending, reflect on..."
                  style={{ minHeight: '150px' }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Session Protocol</label>
                <textarea
                  className="form-textarea code-editor"
                  value={formData.session_protocol}
                  onChange={(e) => updateField('session_protocol', e.target.value)}
                  placeholder="Optional YAML — orchestrator coordination rules for session structure"
                  style={{ minHeight: '100px' }}
                />
                <div className="form-hint">
                  Orchestrator-owned. Not sent to the agent — defines session coordination rules.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Relational Grounding</label>
                <textarea
                  className="form-textarea code-editor"
                  value={formData.relational_grounding}
                  onChange={(e) => updateField('relational_grounding', e.target.value)}
                  placeholder="Optional YAML — relational context preserved across sessions"
                  style={{ minHeight: '100px' }}
                />
                <div className="form-hint">
                  Orchestrator-owned. Not sent to the agent — defines relational context that persists between sessions.
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Model & Parameters */}
          {activeTab === 1 && (
            <div className="tab-panel active">
              <div className="form-group">
                <label className="form-label">Model Override</label>
                <select
                  className="form-select"
                  value={formData.model_override || ''}
                  onChange={(e) => updateField('model_override', e.target.value || null)}
                >
                  <option value="">Use default (Claude Opus 4.6)</option>
                  <option value="claude-opus-4-7">Claude Opus 4.7</option>
                  <option value="claude-opus-4-6">Claude Opus 4.6</option>
                  <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
                  <option value="claude-opus-4-1-20250805">Claude Opus 4.1</option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                  <option value="claude-sonnet-4-5-20250929">Claude Sonnet 4.5</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                </select>
                <div className="form-hint">Leave blank to use global default.</div>
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
                    value={formData.temperature_override || 1.0}
                    onChange={(e) => updateField('temperature_override', parseFloat(e.target.value))}
                  />
                  <span className="slider-value">{(formData.temperature_override || 1.0).toFixed(1)}</span>
                </div>
                <div className="form-hint">0.0 = deterministic, 2.0 = very creative</div>
              </div>

              <div className="form-group">
                <label className="form-label">Max Turns per Session</label>
                <input
                  type="number"
                  className="form-input"
                  min="1"
                  max="50"
                  value={formData.max_turns}
                  onChange={(e) => updateField('max_turns', parseInt(e.target.value) || 8)}
                  style={{ width: '100px' }}
                />
                <div className="form-hint">Number of conversation turns per session before the close protocol is triggered. Default: 8.</div>
              </div>

              <div className="form-group">
                <label className="form-label">Session Interval</label>
                <select
                  className="form-select"
                  value={formData.session_interval}
                  onChange={(e) => updateField('session_interval', parseInt(e.target.value))}
                >
                  <option value={300}>Every 5 minutes</option>
                  <option value={900}>Every 15 minutes</option>
                  <option value={1800}>Every 30 minutes</option>
                  <option value={3600}>Every 1 hour</option>
                  <option value={21600}>Every 6 hours</option>
                  <option value={86400}>Every 1 day</option>
                </select>
                <div className="form-hint">Minimum time between sessions. The orchestrator waits at least this long after a session completes before starting the next one.</div>
              </div>
            </div>
          )}

          {/* Tab 3: Capabilities */}
          {activeTab === 2 && (
            <div className="tab-panel active">
              <div className="form-hint" style={{ marginBottom: 'var(--space-4)' }}>
                Configure which tools are available to the agent and from which turn they become accessible.
              </div>

              <table className="basin-table">
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>Enabled</th>
                    <th>Available from turn</th>
                  </tr>
                </thead>
                <tbody>
                  {formData.capabilities.map((cap, index) => (
                    <tr key={cap.name}>
                      <td style={{ fontFamily: 'var(--font-data)' }}>{cap.name}</td>
                      <td>
                        <Toggle
                          checked={cap.enabled}
                          onChange={(checked) => updateCapability(index, 'enabled', checked)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="form-input"
                          min="1"
                          max="20"
                          value={cap.available_from_turn}
                          onChange={(e) => updateCapability(index, 'available_from_turn', parseInt(e.target.value))}
                          disabled={!cap.enabled}
                          style={{ width: '80px' }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Tab 4: Basins */}
          {activeTab === 3 && (
            <div className="tab-panel active">
              <div className="form-hint" style={{ marginBottom: 'var(--space-4)' }}>
                Basin parameters control attractor dynamics. Alpha is clamped to [0.05, 1.0].
              </div>

              <table className="basin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Class</th>
                    <th>Alpha</th>
                    <th>Lambda</th>
                    <th>Eta</th>
                    <th>Tier</th>
                    {isEditMode && <th>Modified</th>}
                    {isEditMode && <th>Lock</th>}
                    {isEditMode && <th>Hist.</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {formData.basins.map((basin, index) => {
                    const def = basinDefMap.get(basin.name);
                    return (
                      <tr key={index} className={def?.locked_by_brain ? 'basin-locked' : ''}>
                        <td>
                          <input
                            type="text"
                            className="form-input mono"
                            value={basin.name}
                            onChange={(e) => updateBasin(index, 'name', e.target.value)}
                            placeholder="basin_name"
                            style={{ minWidth: '140px' }}
                          />
                        </td>
                        <td>
                          <select
                            className="form-select"
                            value={basin.class}
                            onChange={(e) => updateBasin(index, 'class', e.target.value as BasinClass)}
                          >
                            <option value="core">core</option>
                            <option value="peripheral">peripheral</option>
                            <option value="emergent">emergent</option>
                          </select>
                        </td>
                        <td>
                          <div className="slider-wrapper">
                            <input
                              type="range"
                              className="slider"
                              min="0.05"
                              max="1"
                              step="0.01"
                              value={basin.alpha}
                              onChange={(e) => updateBasin(index, 'alpha', parseFloat(e.target.value))}
                            />
                            <span className="slider-value">{basin.alpha.toFixed(2)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="slider-wrapper">
                            <input
                              type="range"
                              className="slider"
                              min="0.5"
                              max="1"
                              step="0.01"
                              value={basin.lambda}
                              onChange={(e) => updateBasin(index, 'lambda', parseFloat(e.target.value))}
                            />
                            <span className="slider-value">{basin.lambda.toFixed(2)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="slider-wrapper">
                            <input
                              type="range"
                              className="slider"
                              min="0"
                              max="0.5"
                              step="0.01"
                              value={basin.eta}
                              onChange={(e) => updateBasin(index, 'eta', parseFloat(e.target.value))}
                            />
                            <span className="slider-value">{basin.eta.toFixed(2)}</span>
                          </div>
                        </td>
                        <td>
                          <select
                            className="form-select"
                            value={basin.tier}
                            onChange={(e) => updateBasin(index, 'tier', parseInt(e.target.value) as Tier)}
                            style={{ width: '70px' }}
                          >
                            <option value="1">1</option>
                            <option value="2">2</option>
                            <option value="3">3</option>
                          </select>
                        </td>
                        {isEditMode && (
                          <td>
                            {def ? (
                              <ModifierIndicator modifiedBy={def.last_modified_by} modifiedAt={def.last_modified_at} />
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>--</span>
                            )}
                          </td>
                        )}
                        {isEditMode && (
                          <td>
                            {def ? (
                              <button
                                className="action-btn"
                                onClick={() => toggleBasinLock(basin.name, def.locked_by_brain)}
                                title={def.locked_by_brain ? 'Unlock basin' : 'Lock basin'}
                              >
                                {def.locked_by_brain ? (
                                  <Lock size={16} style={{ color: 'var(--accent-attention)' }} />
                                ) : (
                                  <Unlock size={16} />
                                )}
                              </button>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>--</span>
                            )}
                          </td>
                        )}
                        {isEditMode && (
                          <td>
                            {def ? (
                              <button
                                className="action-btn"
                                onClick={() => openHistory(basin.name)}
                                title="View modification history"
                              >
                                <History size={16} />
                              </button>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>--</span>
                            )}
                          </td>
                        )}
                        <td>
                          <button
                            className="action-btn destructive"
                            onClick={() => removeBasin(index)}
                            title="Remove basin"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <Button variant="secondary" onClick={addBasin} style={{ marginTop: 'var(--space-3)' }}>
                <Plus size={16} />
                Add Basin
              </Button>

              {/* Deprecated basins section — edit mode only */}
              {isEditMode && deprecatedDefs.length > 0 && (
                <div style={{ marginTop: 'var(--space-5)' }}>
                  <button
                    onClick={() => setShowDeprecated(!showDeprecated)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      fontSize: '13px',
                      fontFamily: 'var(--font-body)',
                      cursor: 'pointer',
                      padding: 'var(--space-2) 0',
                    }}
                  >
                    {showDeprecated ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Show deprecated ({deprecatedDefs.length})
                  </button>

                  {showDeprecated && (
                    <table className="basin-table" style={{ marginTop: 'var(--space-2)' }}>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Class</th>
                          <th>Alpha</th>
                          <th>Tier</th>
                          <th>Deprecated</th>
                          <th>Rationale</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deprecatedDefs.map((dep) => (
                          <tr key={dep.name} className="basin-deprecated">
                            <td style={{ fontFamily: 'var(--font-data)' }}>{dep.name}</td>
                            <td>{dep.basin_class}</td>
                            <td style={{ fontFamily: 'var(--font-data)' }}>{dep.alpha.toFixed(2)}</td>
                            <td>{dep.tier}</td>
                            <td style={{ fontSize: '12px' }}>
                              {dep.deprecated_at ? timeAgo(dep.deprecated_at) : '--'}
                            </td>
                            <td style={{ fontSize: '12px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {dep.deprecation_rationale || '--'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Basin History Modal */}
              {isEditMode && agentId && (
                <BasinHistoryModal
                  isOpen={historyModalOpen}
                  onClose={() => setHistoryModalOpen(false)}
                  agentId={agentId}
                  basinName={historyBasinName}
                />
              )}
            </div>
          )}

          {/* Tab 5: Tier & Emergence */}
          {activeTab === 4 && (
            <div className="tab-panel active">
              <h3 style={{ fontFamily: 'var(--font-voice)', fontSize: '16px', fontWeight: 600, marginBottom: 'var(--space-4)' }}>
                Tier 2 Auto-Approval
              </h3>

              <div className="form-group">
                <div className="toggle-wrapper" style={{ marginBottom: 'var(--space-3)' }}>
                  <Toggle
                    checked={formData.tier_settings.tier_2_auto_approve}
                    onChange={(checked) =>
                      updateField('tier_settings', { ...formData.tier_settings, tier_2_auto_approve: checked })
                    }
                  />
                  <span className="toggle-label">Enable Tier 2 auto-approval</span>
                </div>
                <div className="form-hint">
                  Automatically approve Tier 2 proposals after N consecutive sessions proposing the same change.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Consecutive threshold</label>
                <input
                  type="number"
                  className="form-input"
                  min="1"
                  max="10"
                  value={formData.tier_settings.tier_2_consecutive_threshold}
                  onChange={(e) =>
                    updateField('tier_settings', {
                      ...formData.tier_settings,
                      tier_2_consecutive_threshold: parseInt(e.target.value),
                    })
                  }
                  disabled={!formData.tier_settings.tier_2_auto_approve}
                  style={{ width: '100px' }}
                />
                <div className="form-hint">Number of consecutive sessions required.</div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: 'var(--space-6) 0' }} />

              <h3 style={{ fontFamily: 'var(--font-voice)', fontSize: '16px', fontWeight: 600, marginBottom: 'var(--space-4)' }}>
                Emergent Basin Auto-Approval
              </h3>

              <div className="form-group">
                <div className="toggle-wrapper" style={{ marginBottom: 'var(--space-3)' }}>
                  <Toggle
                    checked={formData.tier_settings.new_basin_auto_approve}
                    onChange={(checked) =>
                      updateField('tier_settings', { ...formData.tier_settings, new_basin_auto_approve: checked })
                    }
                  />
                  <span className="toggle-label">Enable emergent basin auto-approval</span>
                </div>
                <div className="form-hint">
                  Automatically create new basins when the agent consistently references novel concepts.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Consecutive threshold</label>
                <input
                  type="number"
                  className="form-input"
                  min="1"
                  max="20"
                  value={formData.tier_settings.new_basin_threshold}
                  onChange={(e) =>
                    updateField('tier_settings', {
                      ...formData.tier_settings,
                      new_basin_threshold: parseInt(e.target.value),
                    })
                  }
                  disabled={!formData.tier_settings.new_basin_auto_approve}
                  style={{ width: '100px' }}
                />
                <div className="form-hint">Number of consecutive sessions referencing the new concept.</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sticky action bar */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border-color)',
          padding: 'var(--space-4) var(--space-6)',
          display: 'flex',
          gap: 'var(--space-3)',
          justifyContent: 'flex-end',
        }}
      >
        <Button variant="ghost" onClick={() => navigate('/agents')} disabled={loading}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={handleSubmit} disabled={loading}>
          <Save size={16} />
          {loading ? 'Saving...' : 'Save'}
        </Button>
        {!isEditMode && (
          <Button variant="primary" onClick={handleSaveAndQueue} disabled={loading}>
            <Save size={16} />
            {loading ? 'Saving...' : 'Save & Queue Bootstrap'}
          </Button>
        )}
      </div>
    </div>
  );
}

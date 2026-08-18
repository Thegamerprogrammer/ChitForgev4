import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LIQUID_GLASS_PROFILES, createLiquidGlassMap } from './liquidGlass.js';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { WorldMap } from './map.jsx';
import { loadStoredKey, saveApiKey, clearStoredKey } from './state.js';
import { captureMissionState, generateFollowUp, generateMission, regenerateChit, lengthInfo, reviewChitsWithResearchPacket, runResearchPacket } from './generation.js';
import { discoverGeminiModels, refreshModelCapabilities, MODEL_SELECTION_MODES } from './gemini.js';
import { validateMissionInputs } from './validation.js';
import { downloadBrief } from './export.js';
import { renderMarkdownBold } from './format.js';
import { POI_TYPES } from './validation.js';
import { domainFromUrl } from './sourceValidation.js';

const defaultSliders = { aggression: 0, controversy: 0, diplomacy: 0, length: 0 };
const modes = [
  ['general_auto', 'General / Auto', 'AI maps source-backed global pressure points.'],
  ['selected_only', 'Selected Opposition Only', 'Use only countries selected as opposition on the real world map.'],
  ['selected_global', 'Selected Opposition + Global Research', 'Selected opposition is prioritized; grounded research may add stronger targets.'],
];
const progressStages = ['Research', 'Reading Agenda/Background/Freeze', 'Portfolio Foreign Policy', 'Mapping Opposition', 'Researching Pressure Points', 'Legal Frameworks', 'Generating Main POIs', 'Per-Opposition POIs', 'Structure + Source Validation', 'Fact Check', 'Review', 'Finalizing'];
const MemoWorldMap = React.memo(WorldMap);

function App() {
  const stored = useMemo(() => loadStoredKey(), []);
  const [form, setForm] = useState({ committee: '', agenda: '', portfolio: '', apiKey: stored.key, rememberKey: stored.rememberKey });
  const [showKey, setShowKey] = useState(false);
  const [sliders, setSliders] = useState(defaultSliders);
  const [poiCount, setPoiCount] = useState(5);
  const [poisPerOppositionCountry, setPoisPerOppositionCountry] = useState(0);
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('selected_global');
  const [includeFollowUp, setIncludeFollowUp] = useState(false);
  const [customPoiType, setCustomPoiType] = useState('');
  const [easyLanguage, setEasyLanguage] = useState(false);
  const [oppositionPriority, setOppositionPriority] = useState(false);
  const [researchNotes, setResearchNotes] = useState(() => sessionStorage.getItem('chitforge:researchNotes') || '');
  const [researchLinksText, setResearchLinksText] = useState('');
  const [backgroundGuideText, setBackgroundGuideText] = useState('');
  const [backgroundGuideFile, setBackgroundGuideFile] = useState(null);
  const [freezeDate, setFreezeDate] = useState(() => sessionStorage.getItem('chitforge:freezeDate') || '');
  const [poiTypes, setPoiTypes] = useState(['AUTO']);
  const [activity, setActivity] = useState([]);
  const [portfolioProfile, setPortfolioProfile] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [chits, setChits] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [modelMode, setModelMode] = useState(MODEL_SELECTION_MODES.BEST);
  const [manualModelId, setManualModelId] = useState('');
  const [modelCatalog, setModelCatalog] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);
  const [researchPacket, setResearchPacket] = useState(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [customBackground, setCustomBackground] = useState('');
  const [uiOpacity, setUiOpacity] = useState(100);
  const customBackgroundRef = useRef('');
  const sliderCommitFrame = useRef(0);
  useLiquidGlassResizeObserver();

  const commitSlider = useCallback((key, value) => {
    cancelAnimationFrame(sliderCommitFrame.current);
    sliderCommitFrame.current = requestAnimationFrame(() => {
      setSliders((current) => current[key] === value ? current : { ...current, [key]: value });
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(sliderCommitFrame.current), []);
  useEffect(() => { sessionStorage.setItem('chitforge:researchNotes', researchNotes); }, [researchNotes]);
  useEffect(() => { sessionStorage.setItem('chitforge:freezeDate', freezeDate); }, [freezeDate]);

  const updateForm = (key, value) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (key === 'apiKey' || key === 'rememberKey') saveApiKey(next.apiKey, next.rememberKey);
    if (key === 'apiKey') { setModelCatalog(null); setManualModelId(''); setModelInfo(null); }
  };

  const showError = (err) => setError({ message: err.message || 'Generation failed. Please try again.', diagnostic: err.diagnostic, status: err.status, category: err.category });
  const pushProgress = (next) => { setStatus(next); setActivity((items) => [{ time: new Date().toLocaleTimeString(), stage: next.stage, detail: next.detail, done: next.done, total: next.total }, ...items].slice(0, 14)); };

  const modelSelection = { modelMode, manualModelId };
  const refreshModels = async (verify = false) => {
    if (!form.apiKey.trim()) { setError({ message: 'Missing Gemini API key. Enter your key and try again.' }); return; }
    setModelLoading(true); setError(null);
    try {
      const catalog = verify ? await refreshModelCapabilities(form.apiKey, { force: true }) : await discoverGeminiModels(form.apiKey, { force: true });
      setModelCatalog(catalog);
      if (!manualModelId && catalog.compatible[0]) setManualModelId(catalog.compatible[0].id);
    } catch (err) { showError(err); }
    finally { setModelLoading(false); }
  };

  const runGeneration = async () => {
    const validation = validateMissionInputs({ ...form, poiCount });
    setError(validation ? { message: validation } : null);
    if (validation) return;
    setBusy(true);
    setChits([]);
    setRecommendations([]);
    try {
      setActivity([]);
      const result = await generateMission({ form, sliders, selectedTargets: selected, targetingMode: mode, includeFollowUp, poiCount, poisPerOppositionCountry, poiTypes, customPoiType, researchNotes, researchLinks: researchLinks(), backgroundGuideText, backgroundGuideFile, freezeDate, easyLanguage, oppositionPriority, onProgress: pushProgress, modelSelection });
      setPortfolioProfile(result.portfolioProfile);
      setRecommendations(result.recommendedTargets || []);
      setChits(result.chits);
      setModelInfo(result.modelInfo || null);
      setResearchPacket(result.researchPacket || null);
      if (result.chits.length < poiCount && mode !== 'selected_only') setError({ message: `${result.chits.length} / ${poiCount} POIs generated. Gemini did not return enough distinct, defensible POIs after retry attempts. No duplicates were inserted.` });
      if (!result.chits.length) setError({ message: result.researchPacket?.status === 'RESEARCH UNAVAILABLE' ? (result.researchPacket?.raw?.warning || 'Research unavailable') : result.researchPacket?.status === 'NO USABLE EVIDENCE' ? 'Research completed but no usable evidence survived validation.' : mode === 'selected_only' && !selected.length ? 'Selected Targets Only needs at least one selected target. Zero selected targets is valid in Selected + Global Research mode.' : 'No defensible targets discovered.' });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const addFollowUp = async (index) => {
    setBusy(true);
    try {
      const updated = await generateFollowUp({ form, sliders, chit: chits[index], apiKey: form.apiKey, onProgress: pushProgress, modelSelection });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const regenerateOne = async (index) => {
    setBusy(true);
    try {
      const updated = await regenerateChit({ form, sliders, chit: chits[index], existingChits: chits.filter((_, i) => i !== index), apiKey: form.apiKey, includeFollowUp, onProgress: pushProgress, modelSelection });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => setError({ message: 'Clipboard access was blocked by the browser.' }));
  const copyAll = () => copyText(chits.map((chit, index) => `POI ${index + 1} — ${chit.target}\n${chit.poi}`).join('\n\n'));
  const copyOpposition = () => copyText(chits.filter((chit) => chit.oppositionTarget).map((chit, index) => `OPPOSITION POI ${index + 1} — ${chit.target}\n${chit.poi}`).join('\n\n'));
  const researchLinks = () => researchLinksText.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  const missionStateForCurrentUi = () => captureMissionState({ form, sliders, selectedTargets: selected, targetingMode: mode, includeFollowUp, poiCount, poisPerOppositionCountry, poiTypes, customPoiType, researchNotes, researchLinks: researchLinks(), backgroundGuideText, backgroundGuideFile, freezeDate, easyLanguage, oppositionPriority, modelSelection });
  const runResearchOnly = async () => {
    const validation = validateMissionInputs({ ...form, poiCount: 1 });
    setError(validation ? { message: validation } : null);
    if (validation) return;
    setBusy(true);
    try {
      setActivity([]);
      const packet = await runResearchPacket({ form, missionState: missionStateForCurrentUi(), modelSelection, onProgress: pushProgress });
      setResearchPacket(packet);
      setPortfolioProfile(packet.raw?.portfolioProfile || packet.raw?.portfolio_profile || null);
      setError({ message: packet.status === 'READY' ? `Research packet ready with ${(packet.raw?.pressurePoints || packet.raw?.pressure_points || []).length || 0} retrieved pressure point(s).` : packet.status === 'NO USABLE EVIDENCE' ? 'Research completed but no usable evidence survived validation.' : (packet.raw?.warning || 'Research unavailable') });
    } catch (err) { showError(err); } finally { setBusy(false); setStatus(null); }
  };
  const runReviewCurrent = async () => {
    if (!researchPacket) { setError({ message: 'Run research or generate POIs first so Review has a stored research packet and evidence excerpts.' }); return; }
    setBusy(true);
    try {
      const reviewed = await reviewChitsWithResearchPacket({ chits, form, apiKey: form.apiKey, primaryModel: modelInfo?.model || researchPacket.model, modelSelection, onProgress: pushProgress, researchPacket, missionState: missionStateForCurrentUi() });
      setChits(reviewed);
    } catch (err) { showError(err); } finally { setBusy(false); setStatus(null); }
  };
  const exportBrief = (items = chits) => {
    try { pushProgress({ stage: 'PREPARING DOCX', detail: 'Preparing professional DOCX tactical brief.', done: items.length, total: items.length || 1 }); downloadBrief({ form, sliders, portfolioProfile, chits: items, poiCount, selectedTargets: selected, modelInfo, targetMode: mode }); }
    catch { setError({ message: 'DOCX export failed. Please try again in a modern browser.' }); }
  };

  const commitOpacity = useCallback((_, value) => setUiOpacity(value), []);
  const materialOpacity = 0.55 + (uiOpacity / 100) * 0.45;
  const materialFillAlpha = 0.16 + (uiOpacity / 100) * 0.28;

  return <div className="appShell" style={{ '--material-opacity': materialOpacity, '--material-fill-alpha': materialFillAlpha }}>
    <LiquidGlassFilters />
    <div className="ambientBackdrop" style={customBackground ? { '--custom-background': `url(${customBackground})` } : undefined} />
    <header className="hero glass-panel">
      <div className="heroTitleBlock"><span className="eyebrow">Diplomatic Intelligence Terminal</span><h1 className="titleCard">ChitForge</h1><p>Portfolio intelligence → pressure-point discovery → defensible MUN POI arrays.</p></div>
      <div className="heroActions"><label className="backgroundPicker">Custom background<input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; if (customBackgroundRef.current) URL.revokeObjectURL(customBackgroundRef.current); const nextUrl = URL.createObjectURL(file); customBackgroundRef.current = nextUrl; setCustomBackground(nextUrl); }} /></label><button onClick={() => { if (customBackgroundRef.current) URL.revokeObjectURL(customBackgroundRef.current); customBackgroundRef.current = ''; setCustomBackground(''); }} disabled={!customBackground}>Reset Background</button><button onClick={() => exportBrief()} disabled={!chits.length}>Download Tactical Brief (.docx)</button></div>
    </header>
    <main className="layout">
      <section className="panel controls">
        <h2>Mission Parameters</h2>
        <label>Committee<input value={form.committee} onChange={(e) => updateForm('committee', e.target.value)} placeholder="e.g. ECOFIN" /></label>
        <label>Agenda / Topic<textarea value={form.agenda} onChange={(e) => updateForm('agenda', e.target.value)} placeholder="e.g. Sovereign debt restructuring and development finance" /></label>
        <label>Portfolio / Country<input value={form.portfolio} onChange={(e) => updateForm('portfolio', e.target.value)} placeholder="e.g. Indonesia or IDN" /></label>
        <label>Gemini API Key<div className="keyRow"><input type={showKey ? 'text' : 'password'} autoComplete="off" value={form.apiKey} onChange={(e) => updateForm('apiKey', e.target.value)} placeholder="Stored for this session by default" /><button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button></div></label>
        <div className="row"><label className="check switchField"><input type="checkbox" checked={form.rememberKey} onChange={(e) => updateForm('rememberKey', e.target.checked)} /><span className="glassSwitch" aria-hidden="true"><i /></span><span>Save beyond this session</span></label><button onClick={() => { clearStoredKey(); setForm({ ...form, apiKey: '', rememberKey: false }); }}>Clear Key</button></div>

        <h2>AI Model</h2>
        <div className="modelBox" onFocus={() => !modelCatalog && form.apiKey.trim() && refreshModels(false)}>
          <select value={modelMode} onChange={(e) => setModelMode(e.target.value)}>
            <option value={MODEL_SELECTION_MODES.BEST}>Best Available</option>
            <option value={MODEL_SELECTION_MODES.ROTATION}>Smart Rotation</option>
            <option value={MODEL_SELECTION_MODES.MANUAL}>Manual</option>
          </select>
          {modelMode === MODEL_SELECTION_MODES.MANUAL && <select value={manualModelId} onChange={(e) => setManualModelId(e.target.value)} onFocus={() => !modelCatalog && refreshModels(false)}>
            {(modelCatalog?.compatible || []).map((m) => <option key={m.id} value={m.id}>{m.displayName} — ✓ Text generation · JSON recovery</option>)}
          </select>}
          <div className="row"><button className="modelRefreshButton" type="button" onClick={() => refreshModels(false)} disabled={modelLoading}>{modelLoading ? 'Refreshing…' : 'Refresh Model'}</button><button className="modelRefreshButton" type="button" onClick={() => refreshModels(true)} disabled={modelLoading}>Refresh Model Availability</button></div>
          <ModelStatus modelInfo={modelInfo} modelCatalog={modelCatalog} modelMode={modelMode} />
        </div>
        <h2>Targeting Mode</h2>
        <div className="modes">{modes.map(([id, label, help]) => <label key={id} className="mode"><input type="radio" checked={mode === id} onChange={() => setMode(id)} /> <b>{label}</b><small>{help}</small></label>)}</div>
        <label>POIs to Generate<input type="number" min="1" max="100" value={poiCount} onChange={(e) => setPoiCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></label><label>POIs per opposing country<input type="number" min="0" max="20" value={poisPerOppositionCountry} onChange={(e) => setPoisPerOppositionCountry(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} /></label>
        <label className="check switchField"><input type="checkbox" checked={easyLanguage} onChange={(e) => setEasyLanguage(e.target.checked)} /><span className="glassSwitch" aria-hidden="true"><i /></span><span>Easy Language</span></label><label className="check switchField"><input type="checkbox" checked={oppositionPriority} onChange={(e) => setOppositionPriority(e.target.checked)} /><span className="glassSwitch" aria-hidden="true"><i /></span><span>Opposition Priority</span></label><label className="check switchField"><input type="checkbox" checked={includeFollowUp} onChange={(e) => setIncludeFollowUp(e.target.checked)} /><span className="glassSwitch" aria-hidden="true"><i /></span><span>Generate Follow-Up</span></label>
        <h2>POI Type</h2>
        <div className="typeGrid" role="group" aria-label="POI type selection">{POI_TYPES.map((type) => <label key={type} className={`typeChip ${poiTypes.includes(type) ? 'active' : ''}`}>
          <input type="checkbox" checked={poiTypes.includes(type)} onChange={() => setPoiTypes((current) => {
            if (type === 'AUTO') return ['AUTO'];
            const withoutAuto = current.filter((item) => item !== 'AUTO');
            const next = withoutAuto.includes(type) ? withoutAuto.filter((item) => item !== type) : [...withoutAuto, type];
            return next.length ? next : ['AUTO'];
          })} /> {type}
        </label>)}</div>{poiTypes.includes('CUSTOM') && <label className="customTypeField">Custom POI Type<input value={customPoiType} onChange={(e) => setCustomPoiType(e.target.value)} placeholder="Exact classification label" /></label>}

        <h2>Research Mode</h2><div className="researchPanel glass-panel"><label>Research Notes<textarea value={researchNotes} onChange={(e) => setResearchNotes(e.target.value)} placeholder="Optional notes; changes invalidate factual cache." /></label><label>Research Links<textarea value={researchLinksText} onChange={(e) => setResearchLinksText(e.target.value)} placeholder="Optional URLs, one per line." /></label><label>Background Guide<input type="file" accept=".txt,.md,.pdf,.docx" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) { setBackgroundGuideText(''); setBackgroundGuideFile(null); return; } const buffer = await file.arrayBuffer(); const bytes = new Uint8Array(buffer); let binary = ''; for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]); setBackgroundGuideFile({ name: file.name, mimeType: file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'text/plain'), base64: btoa(binary) }); setBackgroundGuideText(file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name) ? await file.text().catch(() => '') : ''); }} /></label><label>Freeze Date<input value={freezeDate} onChange={(e) => setFreezeDate(e.target.value)} placeholder="Optional, e.g. 2026-08-15" /></label><div className="researchBuckets"><span>Scandals / Controversies</span><span>Verified Historical Bad Events</span></div><div className="row"><button type="button" onClick={runResearchOnly} disabled={busy}>Run Research Only</button><button type="button" onClick={runReviewCurrent} disabled={busy || !chits.length}>Run Review on Current POIs</button></div></div>

        <div className="notice"><b>TARGETS: OPTIONAL</b><br />{selected.length ? `${selected.length} manual target(s) selected.` : 'GLOBAL RESEARCH ENABLED unless Selected Targets Only is used.'}</div>
        {Object.keys(sliders).map((key) => <GlassRange key={key} name={key} value={sliders[key]} info={key === 'length' ? lengthInfo(sliders.length) : null} onCommit={commitSlider} />)}
        <button className="primary" onClick={runGeneration} disabled={busy}>{busy ? 'Synthesizing Tactical POIs…' : 'Generate Tactical POI Array'}</button>
        {error && <ErrorBox error={error} />}
      </section>
      <section className="panel mapPanel"><h2>Real World Target Map</h2><MemoWorldMap selected={selected} setSelected={setSelected} portfolio={form.portfolio} setPortfolio={(country) => updateForm('portfolio', country.name)} /></section>
      <aside className="panel queue glass-sidebar"><details className="settingsPanel" open><summary>Generation Settings</summary><div className="settingsGrid"><span>POI Count<b>{poiCount}</b></span><span>POI Type<b>{poiTypes.join(', ')}</b></span><span>Target Mode<b>{mode}</b></span><span>Follow-ups<b>{includeFollowUp ? 'ON' : 'OFF'}</b></span><span>Model<b>{modelInfo?.model?.displayName || modelMode}</b></span><span>Aggression<b>{sliders.aggression}</b></span><span>Controversy<b>{sliders.controversy}</b></span><span>Diplomacy<b>{sliders.diplomacy}</b></span><span>Length<b>{sliders.length}</b></span></div><GlassRange name="opacity" value={uiOpacity} onCommit={commitOpacity} /></details><h2>Selected Targets</h2>{selected.length ? selected.map((c) => <button key={c.iso} className="pill" onClick={() => setSelected(selected.filter((x) => x.iso !== c.iso))}>{c.name}<span>{c.iso}</span>×</button>) : <p className="muted">No manual targets selected. Auto-discovery can generate anyway.</p>}<button onClick={() => setSelected([])}>Clear selections</button>{recommendations.length > 0 && <><h2>AI Recommended Targets</h2>{recommendations.map((target) => <div className="recommendation" key={`${target.name}-${target.reason}`}><b>{target.name}</b><small>{target.reason}</small></div>)}</>}{(busy || status) && <ProgressPanel status={status} poiCount={poiCount} activity={activity} />}</aside>
    </main>
    {portfolioProfile && <PortfolioIntel profile={portfolioProfile} />}
    {chits.length > 0 && <section className="poiWindow"><div className="arrayHeader"><div><span className="eyebrow">CHITFORGE</span><h2>TACTICAL POI ARRAY</h2><strong>{chits.length} / {poiCount} POIs GENERATED</strong>{modelInfo?.model && <strong>MODEL: {modelInfo.model.displayName}</strong>}<strong>FACT CHECK: 2-PASS</strong></div><div className="actions"><button onClick={copyAll}>Copy All</button><button onClick={copyOpposition}>Copy All Opposition POIs</button><button onClick={() => exportBrief()}>Download DOCX</button><button onClick={runGeneration} disabled={busy}>Regenerate All</button></div></div><div className="chits">{chits.map((chit, i) => <ChitCard key={`${chit.target}-${i}-${chit.poi}`} chit={chit} number={i + 1} onCopy={copyText} onExport={() => exportBrief([chit])} onFollowUp={() => addFollowUp(i)} onRegenerate={() => regenerateOne(i)} />)}</div></section>}
  </div>;
}


const GlassRange = React.memo(function GlassRange({ name, value, info, onCommit }) {
  const [displayValue, setDisplayValue] = useState(value);
  const shellRef = useRef(null);
  const inputRef = useRef(null);
  const frameRef = useRef(0);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
    shellRef.current?.style.setProperty('--slider-ratio', String(value / 100));
    shellRef.current?.style.setProperty('--value', `${value}%`);
    if (inputRef.current) inputRef.current.value = String(value);
  }, [value]);

  const updateVisual = useCallback((nextValue) => {
    valueRef.current = nextValue;
    setDisplayValue(nextValue);
    shellRef.current?.style.setProperty('--slider-ratio', String(nextValue / 100));
    shellRef.current?.style.setProperty('--value', `${nextValue}%`);
    if (inputRef.current) inputRef.current.value = String(nextValue);
  }, []);

  const valueFromPointer = useCallback((event) => {
    const shell = shellRef.current;
    if (!shell) return valueRef.current;
    const rect = shell.getBoundingClientRect();
    const styles = getComputedStyle(shell);
    const padding = Number.parseFloat(styles.getPropertyValue('--slider-padding')) || 0;
    const thumbSize = Number.parseFloat(styles.getPropertyValue('--slider-thumb-size')) || 0;
    const trackWidth = Math.max(1, rect.width - (padding * 2) - thumbSize);
    const thumbCenter = event.clientX - rect.left - padding - (thumbSize / 2);
    return Math.round(Math.min(100, Math.max(0, (thumbCenter / trackWidth) * 100)));
  }, []);

  const commitValue = useCallback((nextValue) => {
    cancelAnimationFrame(frameRef.current);
    onCommit(name, nextValue);
  }, [name, onCommit]);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateVisual(valueFromPointer(event));
  }, [updateVisual, valueFromPointer]);

  const handlePointerMove = useCallback((event) => {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.preventDefault();
    updateVisual(valueFromPointer(event));
  }, [updateVisual, valueFromPointer]);

  const handlePointerEnd = useCallback((event) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    const nextValue = valueFromPointer(event);
    updateVisual(nextValue);
    commitValue(nextValue);
  }, [commitValue, updateVisual, valueFromPointer]);

  const handleInput = useCallback((event) => {
    updateVisual(Number(event.currentTarget.value));
  }, [updateVisual]);

  const commitNow = useCallback((event) => {
    commitValue(Number(event.currentTarget.value));
  }, [commitValue]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return <label className="slider glassSlider">
    <span>{name}<b>{displayValue}%</b></span>
    {info && <small>{info.lines}<br />{info.words}</small>}
    <div className="glassSliderShell" ref={shellRef} style={{ '--slider-ratio': displayValue / 100, '--value': `${displayValue}%` }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerEnd} onPointerCancel={handlePointerEnd}>
      <i className="glassSliderFill" />
      <input ref={inputRef} type="range" min="0" max="100" defaultValue={displayValue} onInput={handleInput} onChange={commitNow} onKeyUp={commitNow} onBlur={commitNow} />
    </div>
  </label>;
});

function ModelStatus({ modelInfo, modelCatalog, modelMode }) {
  const active = modelInfo?.model || modelCatalog?.compatible?.[0];
  return <div className="modelStatus"><b>AI ENGINE</b>{active ? <><p>{modelInfo?.fallbackLog?.length ? '↻' : '●'} {active.displayName}</p><small>{modelMode === MODEL_SELECTION_MODES.BEST ? 'BEST AVAILABLE' : modelMode === MODEL_SELECTION_MODES.ROTATION ? 'SMART ROTATION' : 'MANUAL'} · {active.compatibilityStatus}</small>{modelInfo?.fallbackLog?.length > 0 && <small>Fallback from unavailable model</small>}</> : <small>Models are discovered after you enter one Gemini API key.</small>}{modelCatalog?.all?.length > 0 && <details><summary>Compatible models</summary>{modelCatalog.all.map((m) => <p key={m.id} className={m.structuredJson ? 'pass' : 'warn'}>{m.displayName} — {m.compatibilityStatus} — {Math.round(m.priority)} pts</p>)}</details>}</div>;
}

function ErrorBox({ error }) {
  return <div className="error"><b>{error.category ? 'GEMINI ERROR' : 'MISSION ERROR'}</b><p>{error.message}</p>{import.meta.env.DEV && error.diagnostic && <pre>{error.diagnostic}</pre>}</div>;
}

function ProgressPanel({ status, poiCount, activity }) {
  const currentIndex = Math.max(0, progressStages.indexOf(status?.stage));
  const pct = Math.round(((currentIndex + (status?.done && status?.total ? status.done / status.total : 0.35)) / progressStages.length) * 100);
  return <div className="progress glass-progress" aria-live="polite"><span className="eyebrow">CHITFORGE</span><h2>SYNTHESIS ENGINE</h2><strong>{status?.stage || 'INITIALIZING'}</strong><small>{status?.detail || 'Preparing tactical synthesis.'}</small><div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div><b>{Math.min(100, pct)}%</b><p>POI {Math.min(status?.done || 0, status?.total || poiCount)} / {status?.total || poiCount}</p><div className="stageList">{progressStages.map((stage, index) => <span key={stage} className={index < currentIndex ? 'complete' : index === currentIndex ? 'active' : 'pending'}>{index < currentIndex ? '✓' : index === currentIndex ? '→' : '○'} {String(index + 1).padStart(2, '0')} {stage}</span>)}</div><div className="activityFeed">{activity.map((item, idx) => <p key={`${item.time}-${idx}`}><time>{item.time}</time> <span>{idx === 0 ? '→' : '✓'}</span> {item.detail || item.stage}</p>)}</div></div>;
}

function PortfolioIntel({ profile }) {
  return <section className="panel intel glass-panel"><h2>Portfolio Intelligence</h2><p>{profile.summary}</p>{(profile.statements || []).map((statement, idx) => <div className="sourceCard" key={idx}><StatusBadge status={statement.status || 'MANUAL VERIFICATION'} /><p>{statement.text || statement.claim || statement}</p>{(statement.sources || profile.sources || []).slice(0, 2).map((source, i) => <SourceCard source={source} key={`${source.url}-${i}`} />)}</div>)}<div className="intelGrid">{(profile.interests || []).map((item) => <span key={item}>{item}</span>)}</div></section>;
}


function StatusBadge({ status }) {
  const normalized = String(status || 'PENDING').toUpperCase().replace(/_/g, ' ');
  const symbol = normalized === 'VERIFIED' ? '✓' : normalized === 'FAILED' ? '✕' : normalized === 'PENDING' ? '○' : '⚠';
  return <span className={`statusBadge ${normalized.toLowerCase().replace(/\s+/g, '-')}`}>{symbol} {normalized}</span>;
}

function SourceCard({ source }) {
  const domain = source.domain || domainFromUrl(source.url);
  return <div className="sourceCard glass-source-card"><div><b>SOURCE</b><h3>{source.sourceName || 'Manual verification source'}</h3><p>Organization: {source.organization || 'MANUAL VERIFICATION'}<br />Published: {source.publicationDate || 'MANUAL VERIFICATION'}</p></div><div><b>STATUS</b><StatusBadge status={source.status || 'MANUAL VERIFICATION'} /><p><b>SOURCE QUALITY</b><br />{source.quality || 'LIMITED'}</p></div><p><b>CLAIM SUPPORTED</b><br />{source.claimSupported || source.claim || 'MANUAL VERIFICATION: claim support must be checked.'}</p>{source.url && <a className="sourceLink" href={source.url} target="_blank" rel="noreferrer">OPEN SOURCE ↗ {domain && <small>{domain}</small>}</a>}{source.verificationReason && <small>{source.verificationReason}</small>}</div>;
}

function ChitCard({ chit, number, onCopy, onFollowUp, onRegenerate }) {
  const full = JSON.stringify(chit, null, 2);
  return <article className="chit glassCard">
    <div className="chitHead"><b>POI #{number}</b><span>{chit.classification || chit.pressureProfile?.classification}</span></div>
    <p className="targetLine">TARGET: <strong>{chit.target}</strong>{chit.oppositionTarget && <span className="oppositionTag">OPPOSITION TARGET</span>}</p>
    <blockquote className="poiQuestion" dangerouslySetInnerHTML={{ __html: `“${renderMarkdownBold(chit.poi)}”` }} />
    <section className="metrics"><span>{chit.wordCount} WORDS</span><span>{chit.estimatedLines} </span><span>~{chit.estimatedSeconds} SEC</span><span>PRESSURE {chit.pressureScore ?? chit.pressureProfile?.score}/100</span><span>AGGRESSION {chit.pressureProfile?.aggression}%</span><span>CONTROVERSY {chit.pressureProfile?.controversy}%</span><span>DIPLOMACY {chit.pressureProfile?.diplomacy}%</span><span>LENGTH {chit.pressureProfile?.length}%</span></section>
    <div className="accordion"><details><summary>Legal Foundation</summary><p>{chit.legalFoundation || chit.legalPolicyFoundation}</p></details><details><summary>Evidence & Sources</summary>{(chit.evidence || []).map((e, idx) => <SourceCard source={e} key={`${e.url}-${idx}`} />)}</details><details><summary>Documented Issue</summary><p><b>Portfolio position:</b> {chit.pressurePoint?.portfolioPosition}</p><p><b>Target position/action:</b> {chit.pressurePoint?.targetPositionAction}</p><p><b>Conflict:</b> {chit.pressurePoint?.conflict}</p><p><b>Agenda relevance:</b> {chit.pressurePoint?.agendaRelevance}</p></details><details><summary>Tactical Impact</summary><p>{chit.tacticalImpact}</p><div className="tags">{(chit.legalTacticalTypes || []).map((type) => <span key={type}>{type}</span>)}<span>{chit.classificationReason}</span></div></details><details><summary>Verification</summary><span className="reviewTooltip"><StatusBadge status={chit.review?.status || chit.factCheck?.status || 'PENDING'} /><small>{chit.review?.reason || chit.factCheck?.legalAssessment?.reason || 'Review pending.'}</small></span><p><b>Legal:</b> {chit.factCheck?.legalAssessment?.status || 'UNCERTAIN'} — {chit.factCheck?.legalAssessment?.reason}</p><p><b>Classification:</b> {chit.factCheck?.classificationAssessment?.status || 'UNCERTAIN'} — {chit.factCheck?.classificationAssessment?.reason}</p></details><details open={!!chit.followUp}><summary>Follow-up</summary>{chit.followUp ? <><p><b>Expected evasion:</b> {chit.followUp.expectedEvasion}</p><p><b>Follow-up:</b> {chit.followUp.question}</p></> : <p className="muted">No follow-up generated yet.</p>}</details></div>
    <div className="actions"><button onClick={() => onCopy(chit.poi)}>Copy POI</button><button onClick={() => onCopy(full)}>Copy Full</button><button onClick={onRegenerate}>Regenerate</button><button onClick={onFollowUp}>Generate Follow-up</button></div>
  </article>;
}



function useLiquidGlassResizeObserver() {
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const update = (entries) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        entries.forEach((entry) => {
          const { width, height } = entry.contentRect;
          entry.target.style.setProperty('--glass-width', `${Math.round(width)}px`);
          entry.target.style.setProperty('--glass-height', `${Math.round(height)}px`);
        });
      });
    };
    const observer = new ResizeObserver(update);
    document.querySelectorAll('.hero, .panel, .chit, .poiWindow, .mapWrap, .glassSliderShell, .glassSwitch').forEach((node) => observer.observe(node));
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
}

function LiquidGlassFilters() {
  const filters = useMemo(() => {
    if (typeof document === 'undefined') return [];
    return Object.entries(LIQUID_GLASS_PROFILES).map(([name, profile]) => [`liquid-glass-filter-${name}`, createLiquidGlassMap(profile)]);
  }, []);

  return <svg className="liquidFilterSvg" width="0" height="0" aria-hidden="true" focusable="false" colorInterpolationFilters="sRGB">
    <defs>{filters.map(([id, map]) => <filter key={id} id={id} x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse">
      <feImage href={map.displacementHref} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="displacement_map" />
      <feDisplacementMap in="SourceGraphic" in2="displacement_map" scale={map.scale} xChannelSelector="R" yChannelSelector="G" result="refracted" />
      <feImage href={map.specularHref} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="specular_map" />
      <feGaussianBlur in="specular_map" stdDeviation={map.blurLevel} result="specular_soft" />
      <feBlend in="refracted" in2="specular_soft" mode="screen" />
    </filter>)}</defs>
  </svg>;
}

createRoot(document.getElementById('root')).render(<App />);


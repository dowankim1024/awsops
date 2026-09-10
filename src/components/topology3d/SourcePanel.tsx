'use client';

// Data source picker for the 3D topology view: Live / Fixture / Generator.
// Fully controlled — it renders whatever useTopologySource holds and calls back
// into it, so the page owns the state and this file owns none.
// 3D 토폴로지 뷰의 데이터 소스 선택 패널. 상태는 useTopologySource가 들고, 여기서는 그리기만 한다.
import { useRef } from 'react';
import { Download, RefreshCw, Shuffle, Upload } from 'lucide-react';

import { useLanguage } from '@/lib/i18n/LanguageContext';
import { PRESET_NAMES, type TopologySourceApi } from '@/hooks/useTopologySource';
import { type TopologySource } from '@/lib/topology/types';

const SOURCES: TopologySource[] = ['live', 'fixture', 'generator'];

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, onChange }: SliderProps) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs text-gray-400">
        {label}
        <span className="font-mono text-gray-300">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent-cyan"
      />
    </label>
  );
}

export default function SourcePanel({ source: api }: { source: TopologySourceApi }) {
  const { t } = useLanguage();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const g = api.graph;

  return (
    <div className="bg-navy-800 rounded-lg border border-navy-600 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">{t('topology3d.source.title')}</h2>
        <button
          type="button"
          onClick={() => api.refresh(api.source === 'live')}
          className="p-1.5 rounded text-gray-400 hover:text-accent-cyan hover:bg-navy-700"
          title={t('topology3d.source.refresh')}
        >
          <RefreshCw size={14} className={api.loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {/* Source tabs */}
      <div className="grid grid-cols-3 gap-1 bg-navy-900 rounded p-1">
        {SOURCES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => api.setSource(s)}
            className={`text-xs py-1.5 rounded transition-colors ${
              api.source === s ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t(`topology3d.source.${s}`)}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500">{t(`topology3d.source.${api.source}Hint`)}</p>

      {api.source === 'fixture' && (
        <div className="space-y-2">
          <label className="block text-xs text-gray-400">
            {t('topology3d.source.builtIn')}
            <select
              value={api.uploadName ? '' : api.fixtureId}
              onChange={(e) => api.setFixtureId(e.target.value)}
              className="mt-1 w-full bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-xs text-white"
            >
              {api.uploadName && <option value="">{api.uploadName}</option>}
              {api.fixtures.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {!api.uploadName && (
            <p className="text-xs text-gray-500">
              {api.fixtures.find((f) => f.id === api.fixtureId)?.description}
            </p>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-accent-cyan"
          >
            <Upload size={13} />
            {t('topology3d.source.upload')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void api.loadFile(file);
              e.target.value = ''; // re-selecting the same file must fire again
            }}
          />
        </div>
      )}

      {api.source === 'generator' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-gray-400">
              {t('topology3d.source.preset')}
              <select
                value={api.preset}
                onChange={(e) => api.setPreset(e.target.value as (typeof PRESET_NAMES)[number])}
                className="mt-1 w-full bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-xs text-white"
              >
                {api.preset === 'custom' && <option value="custom">{t('topology3d.source.custom')}</option>}
                {PRESET_NAMES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-gray-400">
              {t('topology3d.source.seed')}
              <div className="mt-1 flex gap-1">
                <input
                  type="number"
                  value={api.params.seed}
                  onChange={(e) => api.setParams({ seed: Number(e.target.value) })}
                  className="w-full bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-xs text-white font-mono"
                />
                <button
                  type="button"
                  onClick={api.rerollSeed}
                  className="px-2 rounded border border-navy-600 text-gray-400 hover:text-accent-cyan"
                  title={t('topology3d.source.reroll')}
                >
                  <Shuffle size={13} />
                </button>
              </div>
            </label>
          </div>

          <Slider
            label={t('topology3d.source.vpcs')}
            value={api.params.vpcs}
            min={1}
            max={4}
            onChange={(v) => api.setParams({ vpcs: v })}
          />
          <Slider
            label={t('topology3d.source.azs')}
            value={api.params.azsPerVpc}
            min={1}
            max={4}
            onChange={(v) => api.setParams({ azsPerVpc: v })}
          />
          <Slider
            label={t('topology3d.source.subnetsPerAz')}
            value={api.params.subnetsPerAzPerTier}
            min={1}
            max={4}
            onChange={(v) => api.setParams({ subnetsPerAzPerTier: v })}
          />
          <Slider
            label={`${t('topology3d.source.ec2Range')} · ${api.params.ec2PerSubnet[0]}–${api.params.ec2PerSubnet[1]}`}
            value={api.params.ec2PerSubnet[1]}
            min={0}
            max={120}
            onChange={(v) =>
              api.setParams({ ec2PerSubnet: [Math.min(api.params.ec2PerSubnet[0], v), v] })
            }
          />
          <Slider
            label={t('topology3d.source.albs')}
            value={api.params.albsPerVpc}
            min={0}
            max={12}
            onChange={(v) => api.setParams({ albsPerVpc: v })}
          />
          <Slider
            label={t('topology3d.source.lambdas')}
            value={api.params.lambdaPerVpc}
            min={0}
            max={60}
            onChange={(v) => api.setParams({ lambdaPerVpc: v })}
          />
          <Slider
            label={t('topology3d.source.rds')}
            value={api.params.rdsPerVpc}
            min={0}
            max={12}
            onChange={(v) => api.setParams({ rdsPerVpc: v })}
          />
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={api.params.natPerAz === 1}
              onChange={(e) => api.setParams({ natPerAz: e.target.checked ? 1 : 0 })}
              className="accent-accent-cyan"
            />
            {t('topology3d.source.nat')}
          </label>
        </div>
      )}

      {/* Status: a rejected fixture lists the offending fields instead of a blank screen */}
      {/* 픽스처가 거절되면 빈 화면 대신 어느 필드가 틀렸는지 보여준다 */}
      {api.error && (
        <div className="rounded border border-accent-red/40 bg-accent-red/10 p-2">
          <p className="text-xs text-accent-red">{api.error}</p>
          {api.issues.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-gray-400 font-mono max-h-32 overflow-y-auto">
              {api.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="border-t border-navy-600 pt-3 space-y-2">
        <p className="text-xs text-gray-400 font-mono">
          {api.loading
            ? t('topology3d.source.loading')
            : g
            ? t('topology3d.source.summary', {
                vpcs: g.vpcs.length,
                subnets: g.subnets.length,
                nodes: g.nodes.length,
                edges: g.edges.length,
              })
            : t('topology3d.source.empty')}
        </p>
        {g?.meta.anonymized && (
          <span className="inline-block rounded bg-accent-purple/15 px-1.5 py-0.5 text-xs text-accent-purple">
            {t('topology3d.source.anonymized')}
          </span>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!g}
            onClick={() => api.exportJson(false)}
            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-accent-cyan disabled:opacity-40"
          >
            <Download size={13} />
            {t('topology3d.source.export')}
          </button>
          <button
            type="button"
            disabled={!g}
            onClick={() => api.exportJson(true)}
            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-accent-purple disabled:opacity-40"
          >
            <Download size={13} />
            {t('topology3d.source.exportAnon')}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Button, Empty, Popover, Slider, Spin } from 'antd';
import { CheckOutlined, RightOutlined } from '@ant-design/icons';
import type { AvailableModelV2 } from '../../../packages/contracts/src/model-configuration-v2';
import { modelDisplayLabel, modelServiceCaption } from './model-display-label';

const effortNames: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export function WorkspaceModelPicker({
  models,
  model,
  effort,
  open,
  disabled,
  loading,
  onOpenChange,
  onModel,
  onEffort,
}: {
  models: AvailableModelV2[];
  model: AvailableModelV2 | undefined;
  effort: string | null;
  open: boolean;
  disabled: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onModel: (model: AvailableModelV2) => void;
  onEffort: (value: string) => void;
}) {
  const [choosingModel, setChoosingModel] = useState(false);
  useEffect(() => {
    if (!open) setChoosingModel(false);
  }, [open]);
  const levels = model?.effortValues ?? [];
  const index = Math.max(
    0,
    levels.indexOf(effort ?? model?.defaultEffort ?? ''),
  );
  const current = levels[index];
  const label = current ? (effortNames[current] ?? current) : 'Standard';
  return (
    <Popover
      trigger="click"
      placement="topRight"
      open={open && !disabled}
      onOpenChange={(next) => {
        if (next && !model) setChoosingModel(true);
        onOpenChange(next);
      }}
      classNames={{ root: 'workspace-model-popover' }}
      content={
        choosingModel ? (
          <div
            className="workspace-model-list"
            role="menu"
            aria-label="选择模型"
          >
            <div className="workspace-model-heading">选择模型</div>
            {loading && <Spin size="small" />}
            {!models.length && !loading && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="没有可用模型"
              />
            )}
            {models.map((entry) => (
              <button
                key={entry.modelEntryId}
                type="button"
                role="menuitemradio"
                aria-checked={entry.modelEntryId === model?.modelEntryId}
                disabled={!entry.available}
                className="workspace-model-row"
                onClick={() => {
                  onModel(entry);
                  setChoosingModel(false);
                }}
              >
                <span>
                  <strong>{modelDisplayLabel(entry)}</strong>
                  <small>
                    {modelServiceCaption(entry)}
                    {!entry.available ? ' · 缺少凭据' : ''}
                  </small>
                </span>
                {entry.modelEntryId === model?.modelEntryId && (
                  <CheckOutlined />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="workspace-effort-panel">
            <button
              type="button"
              className="workspace-model-summary"
              onClick={() => setChoosingModel(true)}
              aria-label="打开模型列表"
            >
              <strong>{label}</strong>
              <span>
                {model ? modelDisplayLabel(model) : '选择模型'}{' '}
                <RightOutlined />
              </span>
            </button>
            {levels.length > 1 ? (
              <Slider
                ariaLabelForHandle="模型思考强度"
                ariaValueTextFormatterForHandle={(position) => {
                  const value = levels[position];
                  return value ? (effortNames[value] ?? value) : '';
                }}
                min={0}
                max={levels.length - 1}
                step={1}
                value={index}
                dots
                marks={Object.fromEntries(
                  levels.map((value, position) => [
                    position,
                    {
                      label: '',
                      style: {},
                      title: effortNames[value] ?? value,
                    },
                  ]),
                )}
                tooltip={{
                  formatter: (position) => {
                    const value = levels[position ?? 0];
                    return value ? (effortNames[value] ?? value) : '';
                  },
                }}
                onChange={(position) => {
                  const value = levels[position];
                  if (value) onEffort(value);
                }}
              />
            ) : (
              <div className="workspace-effort-note">
                {levels.length
                  ? '此模型仅支持当前思考等级'
                  : '此模型未提供可调思考等级'}
              </div>
            )}
          </div>
        )
      }
    >
      <Button
        type="text"
        disabled={disabled}
        className="composer-model-trigger"
        aria-label="本条消息模型与参数"
        title={model ? modelDisplayLabel(model) : '选择模型'}
      >
        <span>
          {model ? modelDisplayLabel(model) : '选择模型'}
          {current ? ` · ${label}` : ''}
        </span>
        <span aria-hidden="true">⌄</span>
      </Button>
    </Popover>
  );
}

import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Select,
  Skeleton,
} from 'antd';
import type { MenuProps } from 'antd';
import { EllipsisOutlined, SearchOutlined } from '@ant-design/icons';
import { z } from 'zod';
import {
  assetNavigationSchema,
  type Asset,
} from '../../../packages/contracts/src/assets';
import type { CaseScope } from './requirements';
import { UiCaseStageBadge, uiStageForReviewState } from './ui-case-workbench';
import { UiRequirementBasis } from './ui-requirement-basis';

type Requirement = z.infer<
  typeof assetNavigationSchema
>['requirements'][number];

export function UiCaseLibraryPane({
  scope,
  requirement,
  requirements,
  available,
  loading,
  scenarios,
  cases,
  sceneId,
  sceneCount,
  search,
  review,
  selected,
  canWrite,
  canReview,
  oldBasisCases,
  stageOf,
  approving,
  onSearch,
  onReview,
  onCurrent,
  onCoverage,
  onHistory,
  onOpen,
  onReviewTeam,
  onAdd,
  onImport,
  onOpenCase,
  onAddToScene,
  canEdit,
  canRemove,
  onEdit,
  onRemove,
  onSelect,
  onApprove,
}: {
  scope: CaseScope | null;
  requirement: Requirement | undefined;
  requirements: Requirement[];
  available: boolean;
  loading: boolean;
  scenarios: Asset[];
  cases: Asset[];
  sceneId: string | undefined;
  sceneCount: number | undefined;
  search: string;
  review: string;
  selected: string[];
  canWrite: boolean;
  canReview: boolean;
  oldBasisCases: Asset[];
  stageOf: (asset: Asset) => ReturnType<typeof uiStageForReviewState>;
  approving: boolean;
  onSearch: (value: string) => void;
  onReview: (value: string) => void;
  onCurrent: () => void;
  onCoverage: () => void;
  onHistory: () => void;
  onOpen: () => void;
  onReviewTeam: () => void;
  onAdd: () => void;
  onImport: () => void;
  onOpenCase: (asset: Asset) => void;
  onAddToScene: (asset: Asset) => void;
  canEdit: (asset: Asset) => boolean;
  canRemove: (asset: Asset) => boolean;
  onEdit: (asset: Asset) => void;
  onRemove: (asset: Asset) => void;
  onSelect: (ids: string[]) => void;
  onApprove: (ids: string[]) => Promise<void>;
}) {
  const [bulk, setBulk] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const canUseScope = Boolean(scope) && available && !loading;
  const currentVersion = requirement?.versions.find(
    (version) => version.id === scope?.requirementVersionId,
  );
  const currentScene = scenarios.find((scene) => scene.id === sceneId);
  const rows = new Map<string | null, Asset[]>();
  for (const asset of cases) {
    const group = rows.get(asset.parentId) ?? [];
    group.push(asset);
    rows.set(asset.parentId, group);
  }
  const keyword = search.trim().toLocaleLowerCase();
  const visibleScenarios = scenarios.filter(
    (scene) =>
      !keyword ||
      (rows.get(scene.id)?.length ?? 0) > 0 ||
      scene.title.toLocaleLowerCase().includes(keyword),
  );
  const actions: MenuProps = {
    items: [
      ...(canUseScope && canReview ? [{ key: 'team', label: '团队评审' }] : []),
      ...(canUseScope && canReview
        ? [{ key: 'batch', label: bulk ? '结束选择用例' : '批量批准' }]
        : []),
    ],
    onClick: ({ key }) => {
      if (key === 'team') onReviewTeam();
      if (key === 'batch') {
        setBulk(!bulk);
        if (bulk) onSelect([]);
      }
    },
  };
  const scopeMeta = scope
    ? [
        scope.historical ? `资料快照 v${scope.versionNo} · 只读` : '',
        requirement?.archived ? '已归档需求' : '',
        currentScene?.title ?? '',
        (sceneCount ??
          (scope.historical
            ? currentVersion?.caseCount
            : requirement?.caseCount) ??
          cases.length) + ' 条用例',
      ]
        .filter(Boolean)
        .join(' · ')
    : '选择左侧需求，浏览该需求的场景及用例。';

  function toggle(id: string) {
    setClosed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="ui-case-library-pane" aria-label="用例列表">
      <div className="ui-case-library-scope">
        <div>
          <div className="row wrap">
            <h2>{requirement?.title ?? scope?.title ?? '全部需求'}</h2>
            {scope && (
              <UiRequirementBasis scope={scope} cases={oldBasisCases} />
            )}
          </div>
          <p className="caption">{scopeMeta}</p>
        </div>
        {scope && (
          <div className="ui-case-library-scope-controls">
            {scope.historical && (
              <Button size="small" onClick={onCurrent}>
                返回需求用例
              </Button>
            )}
            <Button size="small" disabled={!canUseScope} onClick={onCoverage}>
              用例覆盖检查
            </Button>
            <Button size="small" disabled={!canUseScope} onClick={onHistory}>
              评审历史
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={
                !canUseScope ||
                !(scope.historical
                  ? currentVersion?.scenarioCount
                  : requirement?.scenarioCount)
              }
              onClick={onOpen}
            >
              打开工作台
            </Button>
          </div>
        )}
      </div>
      <div className="ui-case-library-list">
        {canUseScope && (canWrite || canReview) && (
          <div className="ui-case-library-actions">
            {canWrite && (
              <Button size="small" onClick={onAdd}>
                新增用例
              </Button>
            )}
            {canWrite && (
              <Button size="small" onClick={onImport}>
                导入用例
              </Button>
            )}
            {canReview && (
              <Dropdown trigger={['click']} menu={actions}>
                <Button
                  size="small"
                  icon={<EllipsisOutlined />}
                  aria-label="更多用例操作"
                />
              </Dropdown>
            )}
            {bulk && canReview && (
              <Button
                size="small"
                type="primary"
                loading={approving}
                disabled={!selected.length}
                onClick={() => void onApprove(selected)}
              >
                预览通过已选 {selected.length} 项
              </Button>
            )}
          </div>
        )}
        <div className="ui-case-library-toolbar">
          <h3>场景与用例</h3>
          <div className="ui-case-library-filters">
            <Input
              size="small"
              prefix={<SearchOutlined />}
              aria-label="搜索用例"
              placeholder="搜索场景或用例"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              allowClear
            />
            <Select
              size="small"
              aria-label="评审状态筛选"
              value={review}
              onChange={onReview}
              options={[
                { value: 'all', label: '全部评审状态' },
                { value: 'unapproved', label: '全部待评审' },
                { value: 'pending', label: '待评审' },
                { value: 'needsOptimization', label: '待 AI 修改' },
                { value: 'aiOptimized', label: '待人工复审' },
                { value: 'approved', label: '已批准' },
              ]}
            />
          </div>
        </div>
        <div className="ui-case-library-scenes">
          {loading ? (
            <Skeleton active />
          ) : !available ? (
            <Empty description="当前需求不在所选范围。" />
          ) : visibleScenarios.length ? (
            visibleScenarios.map((scene) => {
              const group = rows.get(scene.id) ?? [];
              const open = !closed.has(scene.id);
              const owner = !scope
                ? requirements.find((item) =>
                    item.versions.some(
                      (version) => version.id === scene.requirementVersionId,
                    ),
                  )
                : undefined;
              return (
                <section className="ui-case-library-scene" key={scene.id}>
                  <header>
                    <button
                      type="button"
                      className="ui-case-scene-toggle"
                      aria-expanded={open}
                      onClick={() => toggle(scene.id)}
                    >
                      {scene.title}
                    </button>
                    <span>
                      {group.length} 条{owner ? ` · ${owner.title}` : ''}
                    </span>
                  </header>
                  {open &&
                    group.map((asset) => (
                      <div
                        className="ui-case-library-row"
                        key={asset.id}
                        data-bulk={bulk || undefined}
                      >
                        {bulk && (
                          <Checkbox
                            aria-label={`选择${asset.title}`}
                            disabled={!canReview || Boolean(asset.removedAt)}
                            checked={selected.includes(asset.id)}
                            onChange={(event) =>
                              onSelect(
                                event.target.checked
                                  ? [...selected, asset.id]
                                  : selected.filter((id) => id !== asset.id),
                              )
                            }
                          />
                        )}
                        <div className="ui-case-library-row-detail">
                          <strong>{asset.title}</strong>
                          <span className="ui-case-asset-code" title={asset.id}>
                            {asset.id} · r{asset.revisionNo}
                            {asset.removedAt ? ' · 已移除，历史保留' : ''}
                          </span>
                        </div>
                        <UiCaseStageBadge stage={stageOf(asset)} />
                        <div className="row">
                          <Button
                            size="small"
                            onClick={() => onOpenCase(asset)}
                          >
                            {asset.removedAt ? '查看历史' : '打开用例'}{' '}
                            <span aria-hidden="true">›</span>
                          </Button>
                          {canEdit(asset) && (
                            <Dropdown
                              trigger={['click']}
                              menu={{
                                items: [
                                  { key: 'edit', label: '编辑用例' },
                                  ...(canRemove(asset)
                                    ? [
                                        {
                                          key: 'remove',
                                          label: '删除用例',
                                          danger: true,
                                        },
                                      ]
                                    : []),
                                ],
                                onClick: ({ key }) =>
                                  key === 'edit'
                                    ? onEdit(asset)
                                    : onRemove(asset),
                              }}
                            >
                              <Button
                                size="small"
                                icon={<EllipsisOutlined />}
                                aria-label={`用例操作 · ${asset.title}`}
                              />
                            </Dropdown>
                          )}
                        </div>
                      </div>
                    ))}
                  {open && group.length === 0 && (
                    <p className="caption ui-case-library-no-rows">
                      {search.trim() || review !== 'all'
                        ? '此场景暂无匹配用例。'
                        : '该场景暂无用例。'}
                      {canUseScope && canWrite && !scene.removedAt && (
                        <Button
                          size="small"
                          type="link"
                          onClick={() => onAddToScene(scene)}
                        >
                          新增用例
                        </Button>
                      )}
                    </p>
                  )}
                </section>
              );
            })
          ) : (
            <Empty
              description={
                scenarios.length
                  ? '没有匹配用例。可调整搜索条件或评审状态。'
                  : scope && canWrite
                    ? '该需求暂无场景。可点击左侧需求旁的加号新增场景。'
                    : '当前范围没有用例。'
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}

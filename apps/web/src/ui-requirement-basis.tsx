import { Button, Popover, Space } from 'antd';
import type { Asset } from '../../../packages/contracts/src/assets';
import { requirementMaterialsHref } from './requirement-basis';
import type { CaseScope } from './requirements';

export function UiRequirementBasis({
  scope,
  cases,
}: {
  scope: CaseScope;
  cases: Asset[];
}) {
  const versions = new Map<string, number>();
  for (const item of cases) {
    const basis = item.requirementBasis;
    if (basis?.warning && basis.requirementId === scope.requirementId)
      versions.set(basis.basisVersionId, basis.basisVersionNo);
  }
  if (!versions.size) return null;
  return (
    <Popover
      trigger="click"
      title="基于旧资料"
      content={
        <div className="ui-requirement-basis-content">
          <p>有用例采用早于当前资料的依据。</p>
          <Space wrap size={4}>
            {[...versions].map(([id, version]) => (
              <Button
                key={id}
                size="small"
                type="link"
                href={requirementMaterialsHref(
                  scope.projectId,
                  scope.requirementId,
                  id,
                )}
              >
                查看资料快照 v{version}
              </Button>
            ))}
            <Button
              size="small"
              type="link"
              href={requirementMaterialsHref(
                scope.projectId,
                scope.requirementId,
              )}
            >
              查看当前需求资料
            </Button>
          </Space>
        </div>
      }
    >
      <button type="button" className="ui-requirement-basis-tag">
        <i aria-hidden="true" />
        基于旧资料
      </button>
    </Popover>
  );
}
